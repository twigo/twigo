import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TABS_KEPT } from "@twigo/workbench";
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
  layout.resize(strip(), room + 48);
};

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
    `${String(TABS_KEPT + (TAKES[4] ?? 0))}px`,
  );
  fireEvent.click(screen.getByRole("button", { name: "Close details" }));
  await settle(1);
  expect(column.style.minWidth).toBe("");
  layout.resize(column, 1280);
  await settle(1);
  expect(actions().style.marginRight).toBe("0px");
  expect(stageOf(actions())).toBe(1);
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

test("a popover the strip leaves behind does not open again by itself when the strip narrows", async () => {
  laidOut();
  await openList();
  withRoom(500);
  fireEvent.click(screen.getByRole("button", { name: "Filter rows" }));
  await settle(1);
  fireEvent.change(screen.getByRole("textbox", { name: "Filter rows" }), {
    target: { value: "api" },
  });
  await settle();
  act(() => {
    screen.getByRole("button", { name: "Clear filter rows" }).focus();
  });
  withRoom(900);
  await settle(1);
  expect(screen.queryByRole("button", { name: "Filter rows" })).toBeNull();
  expect(
    document.querySelector("[data-radix-popper-content-wrapper]"),
  ).toBeNull();
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
