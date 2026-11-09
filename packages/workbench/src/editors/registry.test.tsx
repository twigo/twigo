import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { testWorkbench } from "../testing";
import { WorkbenchView } from "../WorkbenchView";

afterEach(cleanup);

async function mounted() {
  const workbench = await testWorkbench();
  const unregister = workbench.editors.register({
    id: "test.note",
    scheme: "note",
    title: (uri) => uri.host,
    space: (uri) => uri.searchParams.get("space") ?? undefined,
    component: ({ uri }) => <p>body of {uri}</p>,
  });
  render(
    <StrictMode>
      <WorkbenchView workbench={workbench} />
    </StrictMode>,
  );
  const tabs = () =>
    [...document.querySelectorAll(".dv-tab")].map((tab) => ({
      title: tab.textContent,
      preview: tab
        .querySelector("[data-preview]")
        ?.getAttribute("data-preview"),
    }));
  return { workbench, editors: workbench.editors, tabs, unregister };
}

test("opening a URI shows its editor and makes it the active one", async () => {
  const { workbench, editors, tabs } = await mounted();
  act(() => {
    editors.open("note://first");
  });
  expect(tabs()).toEqual([{ title: "first", preview: "false" }]);
  expect(screen.getByText("body of note://first")).toBeTruthy();
  expect(editors.active).toBe("note://first");
  expect(workbench.keys.lookup(null)("editor.type")).toBe("test.note");
});

test("a preview replaces the previous preview, and pinning keeps it", async () => {
  const { editors, tabs } = await mounted();
  act(() => {
    editors.open("note://a", { preview: true });
  });
  act(() => {
    editors.open("note://b", { preview: true });
  });
  expect(tabs()).toEqual([{ title: "b", preview: "true" }]);
  act(() => {
    editors.pin("note://b");
  });
  act(() => {
    editors.open("note://c", { preview: true });
  });
  expect(tabs()).toEqual([
    { title: "b", preview: "false" },
    { title: "c", preview: "true" },
  ]);
});

test("opening an open URI focuses it; opening it for good pins it", async () => {
  const { editors, tabs } = await mounted();
  act(() => {
    editors.open("note://a", { preview: true });
    editors.open("note://b");
  });
  act(() => {
    editors.open("note://a");
  });
  expect(editors.active).toBe("note://a");
  expect(tabs()).toEqual([
    { title: "a", preview: "false" },
    { title: "b", preview: "false" },
  ]);
});

test("an editor with changes of its own is pinned and marked, also when it opens again", async () => {
  const { editors, tabs } = await mounted();
  const marks = () =>
    document.querySelectorAll('[role="img"][aria-label="Unsaved changes"]')
      .length;
  act(() => {
    editors.open("note://a", { preview: true });
  });
  act(() => {
    editors.setDirty("note://a", true);
  });
  expect(tabs()).toEqual([{ title: "a", preview: "false" }]);
  expect(marks()).toBe(1);
  act(() => {
    editors.open("note://b", { preview: true });
  });
  expect(tabs().map(({ title }) => title)).toEqual(["a", "b"]);
  act(() => {
    editors.close("note://a");
  });
  expect(marks()).toBe(0);
  act(() => {
    editors.open("note://a", { preview: true });
  });
  expect(tabs()).toEqual([
    { title: "b", preview: "true" },
    { title: "a", preview: "false" },
  ]);
  expect(marks()).toBe(1);
  act(() => {
    editors.setDirty("note://a", false);
  });
  expect(marks()).toBe(0);
});

test("each space keeps its own editors", async () => {
  const { workbench, editors, tabs } = await mounted();
  act(() => {
    editors.open("note://prod");
  });
  act(() => {
    workbench.spaces.select("staging");
  });
  expect(tabs()).toEqual([]);
  expect(workbench.keys.lookup(null)("editor.type")).toBeUndefined();
  act(() => {
    workbench.spaces.select("prod-eu");
  });
  expect(tabs()).toEqual([{ title: "prod", preview: "false" }]);
});

test("an editor of another space never lands in the dock of the one shown, and opens once its space is", async () => {
  const { workbench, editors, tabs } = await mounted();
  act(() => {
    editors.open("note://later?space=staging");
    editors.open("note://here?space=prod-eu");
  });
  expect(tabs()).toEqual([{ title: "here", preview: "false" }]);
  expect(editors.active).toBe("note://here?space=prod-eu");

  act(() => {
    workbench.spaces.select("staging");
  });
  expect(tabs()).toEqual([{ title: "later", preview: "false" }]);
  expect(editors.active).toBe("note://later?space=staging");

  act(() => {
    workbench.spaces.select("prod-eu");
  });
  expect(tabs()).toEqual([{ title: "here", preview: "false" }]);
});

test("an editor waiting for a space that does not come next is forgotten", async () => {
  const { workbench, editors, tabs } = await mounted();
  act(() => {
    editors.open("note://later?space=staging");
  });
  act(() => {
    workbench.spaces.select("dev");
  });
  act(() => {
    workbench.spaces.select("staging");
  });
  expect(tabs()).toEqual([]);
  act(() => {
    workbench.spaces.select("prod-eu");
  });
  expect(tabs()).toEqual([]);
});

test("a close for an editor of another space reaches its dock when that space is mounted, whichever space comes first", async () => {
  const { workbench, editors, tabs } = await mounted();
  const closed: string[] = [];
  editors.onClose((uri) => closed.push(uri));
  act(() => {
    workbench.spaces.select("staging");
  });
  act(() => {
    editors.open("note://dead?space=staging");
    editors.open("note://kept?space=staging");
  });
  act(() => {
    workbench.spaces.select("prod-eu");
  });
  act(() => {
    editors.close("note://dead?space=staging");
  });
  expect(closed).toEqual([]);

  act(() => {
    workbench.spaces.select("dev");
  });
  act(() => {
    workbench.spaces.select("staging");
  });
  expect(tabs()).toEqual([{ title: "kept", preview: "false" }]);
  expect(closed).toEqual(["note://dead?space=staging"]);
});

test("opening an editor again withdraws a close that waits for its space, and closing one withdraws an open", async () => {
  const { workbench, editors, tabs } = await mounted();
  act(() => {
    workbench.spaces.select("staging");
  });
  act(() => {
    editors.open("note://again?space=staging");
  });
  act(() => {
    workbench.spaces.select("prod-eu");
  });
  act(() => {
    editors.close("note://again?space=staging");
    editors.open("note://again?space=staging");
    editors.open("note://never?space=staging");
    editors.close("note://never?space=staging");
  });
  act(() => {
    workbench.spaces.select("staging");
  });
  expect(tabs()).toEqual([{ title: "again", preview: "false" }]);
});

test("closing the editor that holds the keyboard focus gives it to the editor that becomes active, and closing another does not move it", async () => {
  const { workbench, editors } = await mounted();
  workbench.editors.register({
    id: "test.field",
    scheme: "field",
    title: (uri) => uri.host,
    component: ({ uri }) => <input aria-label={uri} />,
  });
  act(() => {
    editors.open("field://a");
    editors.open("field://b");
    editors.open("field://c");
  });
  act(() => {
    screen.getByLabelText("field://c").focus();
  });

  act(() => {
    editors.close("field://a");
  });
  expect(document.activeElement).toBe(screen.getByLabelText("field://c"));

  act(() => {
    editors.close("field://c");
  });
  expect(editors.active).toBe("field://b");
  expect(document.activeElement).not.toBe(document.body);
  expect(
    document.activeElement?.contains(screen.getByLabelText("field://b")),
  ).toBe(true);
});

test("closing a tab by its X or a middle click gives the focus to the editor that becomes active", async () => {
  const { workbench, editors } = await mounted();
  workbench.editors.register({
    id: "test.field",
    scheme: "field",
    title: (uri) => uri.host,
    component: ({ uri }) => <input aria-label={uri} />,
  });
  act(() => {
    editors.open("field://a");
    editors.open("field://b");
    editors.open("field://c");
  });
  const inGroup = (uri: string) =>
    document.activeElement !== document.body &&
    (document.activeElement?.contains(screen.getByLabelText(uri)) ?? false);

  const x = screen.getByRole("button", { name: "Close c" });
  act(() => {
    x.focus();
  });
  act(() => {
    fireEvent.click(x);
  });
  expect(editors.active).toBe("field://b");
  expect(inGroup("field://b")).toBe(true);

  act(() => {
    screen.getByLabelText("field://b").focus();
  });
  const tab = screen.getByRole("button", { name: "Close b" }).parentElement;
  if (!tab) throw new Error("no tab");
  act(() => {
    fireEvent(tab, new MouseEvent("auxclick", { button: 1, bubbles: true }));
  });
  expect(editors.active).toBe("field://a");
  expect(inGroup("field://a")).toBe(true);
});

test("opening, moving or a space shown gives the active group the focus that fell to the page, and an editor that can hold it its own", async () => {
  const { workbench, editors } = await mounted();
  const focused: string[] = [];
  workbench.editors.register({
    id: "test.field",
    scheme: "field",
    title: (uri) => uri.host,
    component: ({ uri }) => <input aria-label={uri} />,
    focus: (uri) => {
      focused.push(uri);
    },
  });
  act(() => {
    editors.open("field://a");
  });
  act(() => {
    screen.getByLabelText("field://a").focus();
  });
  act(() => {
    editors.open("field://b");
  });
  expect(document.activeElement).not.toBe(document.body);
  expect(focused).toEqual(["field://a", "field://b"]);

  act(() => {
    (document.activeElement as HTMLElement).blur();
  });
  act(() => {
    editors.open("field://a");
  });
  expect(document.activeElement).not.toBe(document.body);
  expect(focused).toEqual(["field://a", "field://b", "field://a"]);

  act(() => {
    editors.moveActive("right");
  });
  act(() => {
    (document.activeElement as HTMLElement).blur();
  });
  act(() => {
    editors.moveActive("bottom");
  });
  act(() => {
    (document.activeElement as HTMLElement).blur();
  });
  expect(document.activeElement).toBe(document.body);
  const [first, second] = workbench.spaces.list;
  act(() => {
    if (second) workbench.spaces.select(second.id);
  });
  act(() => {
    if (first) workbench.spaces.select(first.id);
  });
  expect(document.activeElement).not.toBe(document.body);
});

test("a focus already held outside the editor area stays where it is when an editor opens", async () => {
  const { workbench, editors } = await mounted();
  workbench.editors.register({
    id: "test.field",
    scheme: "field",
    title: (uri) => uri.host,
    component: ({ uri }) => <input aria-label={uri} />,
  });
  const outside = document.createElement("input");
  document.body.append(outside);
  outside.focus();
  act(() => {
    editors.open("field://a");
  });
  expect(document.activeElement).toBe(outside);
  outside.remove();
});

test("closing an editor says so, while moving it or switching spaces does not", async () => {
  const { workbench, editors } = await mounted();
  const closed: string[] = [];
  editors.onClose((uri) => closed.push(uri));
  act(() => {
    editors.open("note://a");
    editors.open("note://b");
  });
  act(() => {
    void workbench.commands.execute(
      "workbench.action.moveEditorToRightGroup",
      workbench.keys.lookup(null),
    );
  });
  expect(document.querySelectorAll(".dv-groupview")).toHaveLength(2);
  act(() => {
    workbench.spaces.select("staging");
  });
  act(() => {
    workbench.spaces.select("prod-eu");
  });
  expect(closed).toEqual([]);
  act(() => {
    editors.close("note://b");
  });
  expect(closed).toEqual(["note://b"]);
});

test("a URI nothing opens fails loudly", async () => {
  const { editors } = await mounted();
  expect(() => {
    editors.open("nowhere://x");
  }).toThrow("no editor opens nowhere://x");
});

test("the editor commands work on a restored editor nothing opens", async () => {
  const { workbench, editors, tabs, unregister } = await mounted();
  act(() => {
    editors.open("note://a", { preview: true });
  });
  act(() => {
    workbench.spaces.select("staging");
    unregister();
  });
  act(() => {
    workbench.spaces.select("prod-eu");
  });
  expect(screen.getByText("Nothing opens this")).toBeTruthy();
  const lookup = workbench.keys.lookup(null);
  expect(lookup("editor.type")).toBeUndefined();
  await act(() =>
    workbench.commands.execute("workbench.action.keepEditor", lookup),
  );
  expect(tabs()).toEqual([{ title: "a", preview: "false" }]);
  await act(() =>
    workbench.commands.execute("workbench.action.closeActiveEditor", lookup),
  );
  expect(tabs()).toEqual([]);
});
