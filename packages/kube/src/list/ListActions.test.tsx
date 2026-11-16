import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMockBackend } from "@twigo/protocol/mock";
import { STRIP_KEPT } from "@twigo/workbench";
import { tabsIn } from "@twigo/workbench/testing";
import { openList, settle, withScreenSize } from "../../test/workbench";

const layout = withScreenSize(1280);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
});

const strip = () => {
  const found = document.querySelector<HTMLElement>(
    ".dv-tabs-and-actions-container",
  );
  if (!found) throw new Error("no strip");
  return found;
};
const grid = () => screen.getByRole("grid");
const actions = () => {
  const pin = screen.getByRole("button", { name: /to the explorer$/ });
  if (!pin.parentElement) throw new Error("no actions");
  return pin.parentElement;
};

const stageOf = (root: HTMLElement) =>
  [
    root.querySelector("kbd") === null,
    !root.textContent.includes("Group"),
    root.querySelector('input[aria-label="Filter rows"]') === null,
    root.querySelector('[role="group"][aria-label="Rows by health"]') === null,
  ].filter(Boolean).length;

const TAKES = [700, 660, 600, 440, 330];

function laidOut(narrowed: (row: HTMLElement) => number = () => 0) {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this ===
        screen.queryByRole("button", { name: /to the explorer$/ })
          ?.parentElement
        ? (TAKES[stageOf(this)] ?? 0) - narrowed(this)
        : 0;
    },
  });
}

const typed = () =>
  document
    .querySelector<HTMLInputElement>('input[aria-label="Filter rows"]')
    ?.value.toString() ?? "";

const withRoom = (room: number) => {
  layout.resize(strip(), room + 58);
};

const counted = (row: HTMLElement) =>
  [...row.querySelectorAll<HTMLElement>("span.tabular-nums")].reduce(
    (sum, count) =>
      sum +
      7 *
        Math.max(count.textContent.length, count.dataset.reserve?.length ?? 0),
    0,
  );

test("the actions give up one thing at a time as the strip narrows: the key hint, the Group label, the filter field, the health filter", async () => {
  laidOut();
  await openList();
  expect(stageOf(actions())).toBe(0);
  const seen: number[] = [];
  for (const room of [900, 700, 699, 660, 659, 600, 599, 440, 439, 330, 100]) {
    withRoom(room);
    seen.push(stageOf(actions()));
  }
  expect(seen).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4]);
  expect(screen.getByRole("button", { name: "Rows by health" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Filter rows" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Group rows" })).toBeTruthy();
});

test("a strip that widens again brings the actions back in the order they went", async () => {
  laidOut();
  await openList();
  const rooms = [900, 650, 500, 400, 200];
  const narrowing = rooms.map((room) => {
    withRoom(room);
    return stageOf(actions());
  });
  expect(narrowing).toEqual([0, 2, 3, 4, 4]);
  const widening = [...rooms].reverse().map((room) => {
    withRoom(room);
    return stageOf(actions());
  });
  expect(widening.reverse()).toEqual(narrowing);
});

test("the filter that became an icon opens its field, which keeps its text, and / opens it too", async () => {
  laidOut();
  await openList();
  withRoom(500);
  expect(screen.queryByRole("textbox", { name: "Filter rows" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Filter rows" }));
  await settle(1);
  const field = screen.getByRole("textbox", { name: "Filter rows" });
  fireEvent.change(field, { target: { value: "CrashLoop" } });
  await settle();
  fireEvent.keyDown(field, { key: "Enter" });
  await settle(1);
  expect(screen.queryByRole("textbox", { name: "Filter rows" })).toBeNull();
  expect(
    screen
      .getByRole("button", { name: "Filter rows" })
      .className.includes("bg-row-active"),
  ).toBe(true);

  act(() => {
    grid().focus();
  });
  fireEvent.keyDown(grid(), { code: "Slash", key: "Slash" });
  await settle(1);
  expect(
    screen.getByRole<HTMLInputElement>("textbox", { name: "Filter rows" })
      .value,
  ).toBe("CrashLoop");
});

test("the health filter that became a choice names the one it is on and picks another", async () => {
  laidOut();
  await openList();
  withRoom(200);
  const trigger = screen.getByRole("button", { name: "Rows by health" });
  expect(trigger.textContent).toMatch(/^All\s*5,000$/);
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(screen.getByRole("menuitem", { name: /^Failing / }));
  await settle();
  expect(
    screen.getByRole("button", { name: "Rows by health" }).textContent,
  ).toMatch(/^Failing\s*\d/);
});

test("details docked beside the list take their width from the room, and the actions end at the list's edge", async () => {
  laidOut();
  await openList();
  withRoom(680);
  expect(stageOf(actions())).toBe(1);
  expect(actions().style.marginRight).toBe("0px");
  fireEvent.click(screen.getAllByRole("row")[1] ?? document.body);
  await settle(1);
  const column = grid().parentElement;
  if (!column) throw new Error("no list column");
  layout.resize(column, 810);
  await settle(1);
  expect(actions().style.marginRight).toBe("470px");
  expect(stageOf(actions())).toBe(4);
  expect(column.style.minWidth).toBe(
    `${String(STRIP_KEPT + (TAKES[4] ?? 0))}px`,
  );
  fireEvent.click(screen.getByRole("button", { name: "Close details" }));
  await settle(1);
  expect(column.style.minWidth).toBe("");
  layout.resize(column, 1280);
  await settle(1);
  expect(actions().style.marginRight).toBe("0px");
  expect(stageOf(actions())).toBe(1);
});

test("the least a list keeps beside docked details is known as they first dock, though its actions never had to give way", async () => {
  laidOut();
  await openList();
  withRoom(900);
  expect(stageOf(actions())).toBe(0);
  fireEvent.click(screen.getAllByRole("row")[1] ?? document.body);
  await settle(1);
  expect(grid().parentElement?.style.minWidth).toBe(
    `${String(STRIP_KEPT + (TAKES[4] ?? 0))}px`,
  );
});

test("the room the details take is read as they dock, without waiting for the list's width to be reported", async () => {
  laidOut();
  await openList();
  withRoom(900);
  const column = grid().parentElement;
  if (!column) throw new Error("no list column");
  Object.defineProperty(column, "clientWidth", {
    configurable: true,
    get: () => (document.querySelector("aside") ? 810 : 1280),
  });
  expect(actions().style.marginRight).toBe("0px");
  fireEvent.click(screen.getAllByRole("row")[1] ?? document.body);
  expect(actions().style.marginRight).toBe("470px");
  expect(stageOf(actions())).toBe(4);
});

test("the least a list keeps beside docked details follows the health choice its last stage names", async () => {
  laidOut((row) =>
    row
      .querySelector('button[aria-label="Rows by health"]')
      ?.textContent.startsWith("Failing") === true
      ? 50
      : 0,
  );
  await openList();
  withRoom(900);
  fireEvent.click(screen.getAllByRole("row")[1] ?? document.body);
  await settle(1);
  const column = grid().parentElement;
  if (!column) throw new Error("no list column");
  expect(column.style.minWidth).toBe(
    `${String(STRIP_KEPT + (TAKES[4] ?? 0))}px`,
  );
  fireEvent.click(
    within(screen.getByRole("group", { name: "Rows by health" })).getByRole(
      "button",
      { name: /^Failing/ },
    ),
  );
  await settle();
  expect(column.style.minWidth).toBe(
    `${String(STRIP_KEPT + (TAKES[4] ?? 0) - 50)}px`,
  );
});

test("a health just picked keeps the focus while the last stage waits to be measured again", async () => {
  laidOut();
  await openList();
  withRoom(900);
  const failing = within(
    screen.getByRole("group", { name: "Rows by health" }),
  ).getByRole("button", { name: /^Failing/ });
  act(() => {
    failing.focus();
  });
  fireEvent.click(failing);
  await settle();
  expect(failing.getAttribute("aria-pressed")).toBe("true");
  expect(document.activeElement).toBe(failing);
});

test("the filter field keeps its place and its focus while its text, and so the row's width, changes", async () => {
  laidOut(() => (typed() === "" ? 0 : 100));
  await openList(undefined, "k8s-list://prod-eu/v1/pods?q=api");
  withRoom(520);
  expect(stageOf(actions())).toBe(2);
  const field = screen.getByRole<HTMLInputElement>("textbox", {
    name: "Filter rows",
  });
  act(() => {
    field.focus();
  });
  fireEvent.change(field, { target: { value: "" } });
  await settle();
  expect(stageOf(actions())).toBe(2);
  expect(document.activeElement).toBe(field);
  expect(screen.getByRole("textbox", { name: "Filter rows" })).toBe(field);

  act(() => {
    field.blur();
  });
  await settle(1);
  expect(stageOf(actions())).toBe(3);
  expect(screen.queryByRole("textbox", { name: "Filter rows" })).toBeNull();
});

test("a filter that was on while the stages were learnt does not move a stage when it clears: each count keeps the room it took with no text", async () => {
  laidOut((row) => -counted(row));
  await openList();
  withRoom(740);
  const field = screen.getByRole<HTMLInputElement>("textbox", {
    name: "Filter rows",
  });
  const grouped = () => actions().textContent.includes("Group");
  act(() => {
    field.focus();
  });
  fireEvent.change(field, { target: { value: "zzzz" } });
  await settle();
  expect(
    screen.getByRole("group", { name: "Rows by health" }).textContent,
  ).toBe("All0Failing0Pending0Healthy0");
  act(() => {
    grid().focus();
  });
  await settle(1);
  withRoom(900);
  withRoom(740);
  const before = grouped();
  act(() => {
    field.focus();
  });
  fireEvent.change(field, { target: { value: "" } });
  await settle();
  expect(
    screen.getByRole("group", { name: "Rows by health" }).textContent,
  ).toMatch(/^All5,000/);
  expect(grouped()).toBe(before);
  expect(screen.getByRole("textbox", { name: "Filter rows" })).toBe(field);
  expect(document.activeElement).toBe(field);
});

test("a list opened with a text in its URI, whose counts were never seen without it, keeps its stage while the field has the focus, and settles when it loses it", async () => {
  laidOut((row) => -counted(row));
  await openList(undefined, "k8s-list://prod-eu/v1/pods?q=zzzz");
  withRoom(740);
  const grouped = () => actions().textContent.includes("Group");
  expect(grouped()).toBe(true);
  const field = screen.getByRole<HTMLInputElement>("textbox", {
    name: "Filter rows",
  });
  act(() => {
    field.focus();
  });
  fireEvent.change(field, { target: { value: "" } });
  await settle();
  expect(
    screen.getByRole("group", { name: "Rows by health" }).textContent,
  ).toMatch(/^All5,000/);
  expect(grouped()).toBe(true);
  expect(screen.getByRole("textbox", { name: "Filter rows" })).toBe(field);
  expect(document.activeElement).toBe(field);

  act(() => {
    grid().focus();
  });
  await settle(1);
  expect(grouped()).toBe(false);
});

test("the popover keeps its place while its own padding has the focus, which a strip that widens would take with it", async () => {
  laidOut();
  await openList();
  withRoom(500);
  fireEvent.click(screen.getByRole("button", { name: "Filter rows" }));
  await settle(1);
  const dialog = screen.getByRole("dialog");
  act(() => {
    dialog.focus();
  });
  expect(document.activeElement).toBe(dialog);

  withRoom(900);
  await settle(1);
  expect(stageOf(actions())).toBe(3);
  expect(screen.getByRole("dialog")).toBe(dialog);
  expect(document.activeElement).toBe(dialog);
});

test("the popover keeps its field and its focus when the strip widens, and Escape clears the text before it closes", async () => {
  laidOut();
  await openList();
  withRoom(500);
  fireEvent.click(screen.getByRole("button", { name: "Filter rows" }));
  await settle(1);
  const field = screen.getByRole<HTMLInputElement>("textbox", {
    name: "Filter rows",
  });
  act(() => {
    field.focus();
  });
  fireEvent.change(field, { target: { value: "api" } });
  await settle();

  withRoom(900);
  expect(stageOf(actions())).toBe(3);
  expect(screen.getByRole("textbox", { name: "Filter rows" })).toBe(field);
  expect(document.activeElement).toBe(field);

  fireEvent.keyDown(field, { key: "Escape" });
  await settle(1);
  expect(field.value).toBe("");
  expect(screen.getByRole("textbox", { name: "Filter rows" })).toBe(field);
  fireEvent.keyDown(field, { key: "Escape" });
  await settle(1);
  expect(field.isConnected).toBe(false);
  expect(stageOf(actions())).toBe(0);
});

test("the filter keeps its place while its Clear button has the focus, inline or in the popover", async () => {
  laidOut();
  await openList();
  withRoom(620);
  expect(stageOf(actions())).toBe(2);
  fireEvent.change(screen.getByRole("textbox", { name: "Filter rows" }), {
    target: { value: "api" },
  });
  await settle();
  const inline = screen.getByRole("button", { name: "Clear filter rows" });
  act(() => {
    inline.focus();
  });
  withRoom(500);
  await settle(1);
  expect(screen.getByRole("textbox", { name: "Filter rows" })).toBeTruthy();
  expect(document.activeElement).toBe(inline);

  act(() => {
    grid().focus();
  });
  await settle(1);
  fireEvent.click(screen.getByRole("button", { name: "Filter rows" }));
  await settle(1);
  const popped = screen.getByRole("button", { name: "Clear filter rows" });
  act(() => {
    popped.focus();
  });
  withRoom(900);
  await settle(1);
  expect(screen.getByRole("button", { name: "Filter rows" })).toBeTruthy();
  expect(document.activeElement).toBe(popped);
});

test("a popover stays open, and the filter an icon, while the focus is on its trigger and the strip widens; closed, it does not open again by itself", async () => {
  laidOut();
  await openList();
  withRoom(500);
  fireEvent.click(screen.getByRole("button", { name: "Filter rows" }));
  await settle(1);
  const trigger = screen.getByRole("button", { name: "Filter rows" });
  act(() => {
    trigger.focus();
  });
  expect(
    document.querySelector("[data-radix-popper-content-wrapper]"),
  ).not.toBeNull();
  withRoom(900);
  await settle(1);
  expect(stageOf(actions())).toBe(3);
  expect(screen.getByRole("button", { name: "Filter rows" })).toBe(trigger);
  expect(
    document.querySelector("[data-radix-popper-content-wrapper]"),
  ).not.toBeNull();
  expect(document.activeElement).toBe(trigger);

  fireEvent.keyDown(trigger, { key: "Escape" });
  await settle(1);
  expect(
    document.querySelector("[data-radix-popper-content-wrapper]"),
  ).toBeNull();
  expect(stageOf(actions())).toBe(0);
  withRoom(500);
  await settle(1);
  expect(screen.getByRole("button", { name: "Filter rows" })).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Filter rows" })).toBeNull();
});

test("the list in the strip is its own: a list with narrower actions does not inherit the stage of the one before it", async () => {
  laidOut((row) =>
    row.querySelector('[aria-label="Rows by health"]') ? 0 : 240,
  );
  const workbench = await openList();
  withRoom(500);
  expect(stageOf(actions())).toBe(3);
  act(() => {
    workbench.editors.open("k8s-list://prod-eu/v1/configmaps");
  });
  await settle();
  expect(actions().querySelector("kbd")).not.toBeNull();
  act(() => {
    workbench.editors.open("k8s-list://prod-eu/v1/pods");
  });
  await settle();
  expect(stageOf(actions())).toBe(3);
});

const CHIP_FULL = 140;
const CHIP_FLOOR = 90;
const CHIP_COUNT = 50;
const CHIP_GLYPH = 24;
const GAP = 8;

function laidOutScoped() {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      const row = screen.queryByRole("button", {
        name: /to the explorer$/,
      })?.parentElement;
      if (!row) return 0;
      const hidden = [
        ...(row.querySelector(":scope > [aria-hidden]")?.children ?? []),
      ].map((copy) => copy.firstElementChild);
      const natural = [CHIP_FULL, CHIP_FLOOR, CHIP_COUNT, CHIP_GLYPH];
      const copy = hidden.indexOf(this);
      if (copy >= 0) return natural[copy] ?? 0;
      const shown = row.querySelector<HTMLElement>(
        "[aria-label^='Namespace'], [aria-label^='This list shows']",
      )?.parentElement?.parentElement;
      const chip = shown?.firstElementChild;
      const set = chip?.getAttribute("style")?.match(/max-width: (\d+)/)?.[1];
      const max = set === undefined ? Infinity : Number(set);
      const width = chip?.textContent.startsWith("+")
        ? CHIP_COUNT
        : chip?.textContent === ""
          ? CHIP_GLYPH
          : Math.max(CHIP_FLOOR, Math.min(CHIP_FULL, max));
      if (this === shown) return width;
      return this === row
        ? (TAKES[stageOf(this)] ?? 0) + (shown ? GAP + width : 0)
        : 0;
    },
  });
}

async function scopedList(names: readonly string[], uri?: string) {
  laidOutScoped();
  const workbench = await openList(undefined, uri);
  act(() => {
    workbench.spaces.update("prod-eu", (state) => ({
      ...state,
      namespaces: names,
    }));
  });
  await settle(1);
  return workbench;
}

const chip = (name: string | RegExp = /^Namespaces?: /) =>
  screen.getByRole("button", { name });
const noChip = () =>
  screen.queryByRole("button", { name: /^Namespaces?: / }) === null;
const chipRoot = () => chip().parentElement;

test("a narrowed scope shows as a chip with the name, and several namespaces as the first and how many more, the whole list in its label", async () => {
  await scopedList(["payments"]);
  expect(chip("Namespace: payments").textContent).toBe("payments");

  cleanup();
  await scopedList(["payments", "auth", "default"]);
  expect(chip("Namespaces: payments, auth, default").textContent).toMatch(
    /^payments\s*\+2$/,
  );
});

test("no chip while the scope is every namespace, nor on a list of a kind that has no namespaces", async () => {
  laidOutScoped();
  const workbench = await openList();
  expect(noChip()).toBe(true);

  act(() => {
    workbench.spaces.update("prod-eu", (state) => ({
      ...state,
      namespaces: ["payments"],
    }));
  });
  await settle(1);
  expect(noChip()).toBe(false);

  cleanup();
  await scopedList(["payments"], "k8s-list://prod-eu/v1/nodes");
  expect(noChip()).toBe(true);
});

test("a click on the chip opens the namespace picker, and its close mark goes back to every namespace", async () => {
  const workbench = await scopedList(["payments", "auth"]);
  fireEvent.click(chip());
  expect(workbench.quickAccess.session?.value).toBe("ns ");

  fireEvent.click(screen.getByRole("button", { name: "Show all namespaces" }));
  await settle(1);
  expect(workbench.spaces.state("prod-eu").namespaces).toEqual([]);
  expect(noChip()).toBe(true);
});

const OWN = "k8s-list://prod-eu/v1/pods?ns=checkout&q=api";

test("a list pinned with namespaces of its own shows them as a label that no click and no scope changes: no close mark, one tab stop, the names in its tooltip", async () => {
  laidOutScoped();
  const workbench = await openList(undefined, OWN);
  act(() => {
    workbench.spaces.update("prod-eu", (state) => ({
      ...state,
      namespaces: ["payments"],
    }));
  });
  await settle(1);
  const label = screen.getByRole("group", {
    name: "This list shows checkout whatever the space's scope is",
  });
  expect(label.textContent).toBe("checkout");
  expect(label.tabIndex).toBe(0);
  expect(
    screen.queryByRole("button", { name: /namespaces|checkout/i }),
  ).toBeNull();

  fireEvent.click(label);
  expect(workbench.quickAccess.session).toBeUndefined();
  expect(tabsIn("editor")).toEqual([OWN]);
  expect(workbench.spaces.state("prod-eu").namespaces).toEqual(["payments"]);

  act(() => {
    label.focus();
  });
  expect(screen.getByRole("tooltip").textContent).toBe("Namespace: checkout");
});

test("the label of a list with namespaces of its own folds as the chip does and stays one tab stop with every name in its tooltip", async () => {
  laidOutScoped();
  await openList(
    undefined,
    "k8s-list://prod-eu/v1/pods?ns=payments,auth,default",
  );
  await settle(1);
  const shown = [900, 420, 380].map((room) => {
    withRoom(room);
    const label = screen.getByRole("group", { name: /^This list shows/ });
    act(() => {
      label.focus();
    });
    expect(label.tabIndex).toBe(0);
    expect(screen.getByRole("tooltip").textContent).toBe(
      "Namespaces: payments, auth, default",
    );
    act(() => {
      label.blur();
    });
    return label.textContent.trim();
  });
  expect(shown).toEqual(["payments+2", "+2", ""]);
  expect(screen.queryByRole("button", { name: /namespaces/i })).toBeNull();
});

const formOf = () => {
  if (screen.queryByRole("button", { name: "Show all namespaces" }) !== null) {
    const max = chipRoot()?.style.maxWidth ?? "";
    return max === "" ? "whole" : max;
  }
  return chip().textContent === "" ? "glyph" : "count";
};

const seen = (rooms: readonly number[]) =>
  rooms.map((room) => {
    withRoom(room);
    return [stageOf(actions()), formOf()];
  });

test("the chip is the last to give way: the stages go first, then it is cut, down to what holds its name's head and tail, then folded to its glyph", async () => {
  await scopedList(["payments"]);
  expect(
    seen([900, 848, 847, 808, 807, 588, 587, 478, 477, 450, 428, 427, 100]),
  ).toEqual([
    [0, "whole"],
    [0, "whole"],
    [1, "whole"],
    [1, "whole"],
    [2, "whole"],
    [3, "whole"],
    [4, "whole"],
    [4, "whole"],
    [4, "139px"],
    [4, "112px"],
    [4, "90px"],
    [4, "glyph"],
    [4, "glyph"],
  ]);
});

test("several namespaces fold to the glyph and how many more follow before the glyph alone, the names in the label, a click on it still opening the picker, and the close mark gone", async () => {
  const workbench = await scopedList(["payments", "auth", "default"]);
  expect(seen([478, 477, 428, 427, 388, 387, 100])).toEqual([
    [4, "whole"],
    [4, "139px"],
    [4, "90px"],
    [4, "count"],
    [4, "count"],
    [4, "glyph"],
    [4, "glyph"],
  ]);
  expect(screen.queryByRole("button", { name: "Show all namespaces" })).toBe(
    null,
  );
  fireEvent.click(chip("Namespaces: payments, auth, default"));
  expect(workbench.quickAccess.session?.value).toBe("ns ");
});

test("a chip that folded comes back to a fuller form as the room grows, with a pixel to spare", async () => {
  await scopedList(["payments", "auth", "default"]);
  expect(seen([100, 388, 389, 430, 478, 479, 900])).toEqual([
    [4, "glyph"],
    [4, "glyph"],
    [4, "count"],
    [4, "92px"],
    [4, "140px"],
    [4, "whole"],
    [0, "whole"],
  ]);
});

test("the least a list keeps beside docked details counts the chip at its glyph", async () => {
  await scopedList(["payments"]);
  withRoom(900);
  fireEvent.click(screen.getAllByRole("row")[1] ?? document.body);
  await settle(1);
  expect(grid().parentElement?.style.minWidth).toBe(
    `${String(STRIP_KEPT + (TAKES[4] ?? 0) + GAP + CHIP_GLYPH)}px`,
  );
});

test("the chip keeps its form and the focus on its close mark while the strip narrows, and folds once the focus leaves it", async () => {
  await scopedList(["payments"]);
  withRoom(900);
  const close = screen.getByRole("button", { name: "Show all namespaces" });
  act(() => {
    close.focus();
  });
  withRoom(100);
  expect(document.activeElement).toBe(close);
  expect([stageOf(actions()), formOf()]).toEqual([0, "whole"]);

  act(() => {
    close.blur();
  });
  expect([stageOf(actions()), formOf()]).toEqual([4, "glyph"]);
});

test("the close mark of a list that follows the space leaves the focus in the list's editor when the wider list has no grid to take it", async () => {
  laidOutScoped();
  const workbench = await openList(createMockBackend("rbacNamespaces"));
  act(() => {
    workbench.spaces.update("prod-eu", (state) => ({
      ...state,
      namespaces: ["default"],
    }));
  });
  await settle(2);
  expect(screen.queryByRole("grid")).not.toBeNull();

  const close = screen.getByRole("button", { name: "Show all namespaces" });
  act(() => {
    close.focus();
  });
  fireEvent.click(close);
  await settle(3);
  expect(screen.queryByRole("grid")).toBeNull();
  expect(document.activeElement).not.toBe(document.body);
  expect(
    document.querySelector(".dv-groupview")?.contains(document.activeElement),
  ).toBe(true);
});
