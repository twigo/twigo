import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  INITIAL_OBJECT,
  type ObjectSnapshot,
  type ShownUsage,
} from "@twigo/protocol";
import { withScreenSize } from "../../test/workbench";
import { ObjectViews } from "./ObjectViews";
import { PageStates } from "./pageStates";

const size = withScreenSize(1280);

afterEach(cleanup);

const URI = "k8s://dev//v1/pods/web";

const snapshot: ObjectSnapshot = {
  ...INITIAL_OBJECT,
  status: { state: "ready" },
  exists: true,
  overview: {
    header: {
      owner: null,
      node: null,
      created: null,
      printed: [],
      sentence: [],
      vitals: [],
    },
    sections: ["Pod", "Containers", "Metadata"].map((title) => ({
      id: title,
      title,
      summary: [],
      tone: null,
      fold: "open",
      blocks: [
        {
          type: "fields",
          fields: [
            {
              label: "Restart policy",
              value: { type: "text", text: "Always" },
              default: false,
            },
          ],
        },
      ],
    })),
  },
};

function shown(
  text: string,
  {
    focused = false,
    of = snapshot,
    kind = "Pod",
  }: { focused?: boolean; of?: ObjectSnapshot; kind?: string } = {},
) {
  const pages = new PageStates();
  pages.openFilter(URI);
  if (!focused) pages.focused(URI);
  pages.setText(URI, text);
  const views = (of: ObjectSnapshot) => (
    <ObjectViews
      tab="overview"
      snapshot={of}
      onChange={() => undefined}
      pages={pages}
      uri={URI}
      kind={kind}
    />
  );
  const { rerender } = render(views(of));
  const tablist = screen.getByRole("tablist", { name: "Views of the object" });
  const bar = tablist.parentElement;
  const slot = bar?.parentElement;
  const row = slot?.parentElement;
  const counts = row?.querySelectorAll<HTMLElement>(
    ":scope > [aria-hidden] > span",
  );
  const [wide, brief] = counts ?? [];
  const full = bar?.querySelector<HTMLElement>('[data-stage="0"]');
  if (!bar || !slot || !row || !wide || !brief || !full)
    throw new Error("the row is not drawn");
  return {
    bar,
    slot,
    row,
    wide,
    brief,
    full,
    pages,
    rerender: (of: ObjectSnapshot) => {
      rerender(views(of));
    },
  };
}

const tabs = () => screen.getAllByRole("tab").map((tab) => tab.textContent);
const status = () => screen.getByRole("status");
const counted = () => status().nextElementSibling?.textContent;

test("the views keep every tab while the field sits beside them, its count short where the row leaves little, and the field takes a line of its own below that", () => {
  const { slot, row, wide, brief, full } = shown("restart");
  size.resize(full, 277);
  size.resize(wide, 135);
  size.resize(brief, 32);

  size.resize(row, 800);
  expect(tabs()).toHaveLength(4);
  expect(slot.style.minWidth).toBe("289px");
  expect(counted()).toBe("3 matches in 3 sections");

  size.resize(row, 470);
  expect(tabs()).toHaveLength(4);
  expect(slot.style.minWidth).toBe("289px");
  expect(counted()).toBe("3 in 3");
  expect(status().textContent).toBe("3 matches in 3 sections");

  size.resize(row, 360);
  expect(tabs()).toHaveLength(4);
  expect(slot.style.minWidth).toBe("");
  expect(row.className).toContain("flex-col");
  expect(counted()).toBe("3 matches in 3 sections");
});

test("beside the field the views never fold, even when their copy outgrows the room the bar last read", () => {
  const { bar, slot, row, wide, brief, full } = shown("restart");
  const copy = (stage: number) => {
    const found = bar.querySelector<HTMLElement>(
      `[data-stage="${String(stage)}"]`,
    );
    if (!found) throw new Error("no copy");
    return found;
  };
  size.resize(copy(1), 250);
  size.resize(copy(2), 230);
  size.resize(copy(3), 210);
  size.resize(full, 277);
  size.resize(wide, 135);
  size.resize(brief, 32);
  size.resize(row, 800);
  size.resize(bar, 289);
  expect(slot.style.minWidth).toBe("289px");
  size.resize(full, 300);
  expect(slot.style.minWidth).toBe("312px");
  expect(tabs()).toHaveLength(4);
  expect(screen.queryByRole("button", { name: /^More views/ })).toBeNull();
});

const warned = (count: number): ObjectSnapshot => ({
  ...snapshot,
  events: {
    listed: true,
    unavailable: null,
    events: Array.from({ length: count }, (_, index) => ({
      type: "Warning",
      reason: "BackOff",
      message: `restart ${String(index)}`,
      source: "kubelet",
      count: 1,
      first: null,
      last: null,
      fieldPath: null,
    })),
  },
});

test("the row keeps the stage it chose for every object, whatever its Events count and whatever its text finds, since it decides by the widest of both", () => {
  const { slot, row, wide, brief, full, rerender, pages } = shown("restart");
  size.resize(full, 277);
  size.resize(wide, 135);
  size.resize(brief, 32);
  size.resize(row, 470);
  const stage = () =>
    [
      slot.style.minWidth,
      row.className,
      wide.textContent,
      brief.textContent,
      full.querySelector("[data-reserve]")?.getAttribute("data-reserve"),
      full.querySelector('[aria-label="Warnings"]') === null,
    ].join(" | ");
  const chosen = stage();
  expect(chosen).toContain("289px");
  for (const count of [0, 3, 12, 120]) {
    rerender(warned(count));
    expect(stage()).toBe(chosen);
  }
  for (const text of ["pod", "restart", "o", "zzz", "!zzz"]) {
    act(() => {
      pages.setText(URI, text);
    });
    expect(stage()).toBe(chosen);
  }
});

test("the stage follows a views row that grows after it was chosen", () => {
  const { slot, row, wide, brief, full } = shown("restart");
  size.resize(full, 277);
  size.resize(wide, 135);
  size.resize(brief, 32);
  size.resize(row, 470);
  expect(slot.style.minWidth).toBe("289px");
  size.resize(full, 340);
  expect(slot.style.minWidth).toBe("");
  expect(row.className).toContain("flex-col");
  expect(tabs()).toHaveLength(4);
});

test("the stage holds while the field has the focus, and follows the row once it has not", () => {
  const { slot, row, wide, brief, full } = shown("restart");
  size.resize(full, 277);
  size.resize(wide, 135);
  size.resize(brief, 32);
  size.resize(row, 800);
  expect(slot.style.minWidth).toBe("289px");
  const field = screen.getByRole("textbox", { name: "Filter this page" });
  act(() => {
    field.focus();
  });
  size.resize(row, 360);
  expect(slot.style.minWidth).toBe("289px");
  expect(row.className).not.toContain("flex-col");
  act(() => {
    field.blur();
  });
  expect(slot.style.minWidth).toBe("");
  expect(row.className).toContain("flex-col");
});

function tabTo(from: HTMLElement, to: HTMLElement) {
  const between = vi
    .spyOn(document, "activeElement", "get")
    .mockReturnValue(document.body);
  act(() => {
    fireEvent.blur(from, { relatedTarget: to });
  });
  between.mockRestore();
  act(() => {
    to.focus();
  });
}

test("the stage holds while the focus moves between the field and its Clear button, and follows the row once it leaves them", () => {
  const { slot, row, wide, brief, full } = shown("restart", {
    of: warned(120),
  });
  size.resize(full, 277);
  size.resize(wide, 135);
  size.resize(brief, 32);
  size.resize(row, 800);
  expect(slot.style.minWidth).toBe("289px");
  const field = screen.getByRole("textbox", { name: "Filter this page" });
  const clear = screen.getByRole("button", { name: "Clear filter this page" });
  act(() => {
    field.focus();
  });
  size.resize(row, 360);
  tabTo(field, clear);
  expect(slot.style.minWidth).toBe("289px");
  tabTo(clear, field);
  expect(slot.style.minWidth).toBe("289px");
  tabTo(field, clear);
  act(() => {
    clear.blur();
  });
  expect(slot.style.minWidth).toBe("");
  expect(row.className).toContain("flex-col");
});

const crowded = (): ObjectSnapshot => {
  if (!snapshot.overview) throw new Error("no overview");
  return {
    ...warned(120),
    overview: {
      ...snapshot.overview,
      sections: [
        {
          id: "many",
          title: "Many",
          summary: [],
          tone: null,
          fold: "open",
          blocks: [
            {
              type: "fields",
              fields: Array.from({ length: 155 }, (_, index) => ({
                label: `Restart ${String(index)}`,
                value: { type: "text" as const, text: "x" },
                default: false,
              })),
            },
          ],
        },
      ],
    },
  };
};

test("a page that finds more than the count's room, and warnings with more digits than the views keep, take the stage the others have, and the next objects keep it", () => {
  const { slot, row, wide, brief, full, rerender } = shown("restart");
  size.resize(full, 277);
  size.resize(wide, 135);
  size.resize(brief, 32);
  size.resize(row, 470);
  const stage = () =>
    [
      slot.style.minWidth,
      row.className,
      wide.textContent,
      brief.textContent,
    ].join(" | ");
  const chosen = stage();
  expect(chosen).toContain("289px");
  expect(wide.textContent).toBe("99 matches in 9 sections");
  expect(brief.textContent).toBe("99 in 9");
  rerender(crowded());
  expect(counted()).toBe("155 in 1");
  expect(status().textContent).toBe("155 matches in 1 section");
  expect(stage()).toBe(chosen);
  rerender(snapshot);
  expect(stage()).toBe(chosen);
  rerender(crowded());
  expect(stage()).toBe(chosen);
});

const usage: ShownUsage = {
  state: "ready",
  waiting: false,
  sampled: null,
  cpu: { used: null, request: null, limit: null, allocatable: null },
  memory: { used: null, request: null, limit: null, allocatable: null },
  containers: [],
};

test("a node's usage is a section the count finds by its title, and a pod's, which its containers draw, is none", () => {
  const withUsage = { ...snapshot, usage };
  shown("usage", { of: withUsage, kind: "Node" });
  expect(status().textContent).toBe("1 match in 1 section");
  cleanup();
  shown("usage", { of: withUsage });
  expect(status().textContent).toBe("No matches");
});
