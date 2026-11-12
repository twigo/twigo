import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { Copy } from "lucide-react";
import type { ListController } from "../lib/list";
import { DataGrid } from "./DataGrid";
import type { GridItem } from "./types";

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 600,
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 1000,
  });
});

afterAll(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
});

afterEach(cleanup);

function nth(elements: readonly HTMLElement[], index: number): HTMLElement {
  const element = elements[index];
  if (!element) throw new Error(`no element ${String(index)}`);
  return element;
}

function rowNamed(name: string): HTMLElement {
  const row = screen.getByText(name).closest<HTMLElement>('[role="row"]');
  if (!row) throw new Error(`no row ${name}`);
  return row;
}

interface Pod {
  readonly name: string;
}

/** Two groups: auth with two pods, edge with one. */
const ITEMS: readonly GridItem<Pod, string>[] = [
  { type: "group", id: "g:auth", data: "auth", open: true },
  { type: "row", id: "a1", data: { name: "api-1" } },
  { type: "row", id: "a2", data: { name: "api-2" }, tone: "error" },
  { type: "group", id: "g:edge", data: "edge", open: true },
  { type: "row", id: "e1", data: { name: "gateway-1" } },
];

const PODS: readonly GridItem<Pod, string>[] = Array.from(
  { length: 100 },
  (_, index) => ({
    type: "row",
    id: `p${String(index)}`,
    data: { name: `pod-${String(index)}` },
  }),
);

function list(items: readonly (GridItem<Pod, string> | undefined)[]) {
  return {
    length: items.length,
    item: (index: number) => items[index],
    indexOf: (id: string) => items.findIndex((item) => item?.id === id),
  };
}

function scrollable(rows: number): HTMLElement {
  const element = screen.getByRole("grid");
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: 28 + rows * 26,
  });
  Object.defineProperty(element, "scrollTo", {
    configurable: true,
    value: ({ top = 0 }: ScrollToOptions) => {
      element.scrollTop = top;
      fireEvent.scroll(element);
    },
  });
  return element;
}

function scroll(element: HTMLElement, top: number) {
  act(() => {
    element.scrollTop = top;
    fireEvent.scroll(element);
  });
}

type Props = Partial<Parameters<typeof DataGrid<Pod, string>>[0]>;

function grid(overrides: Props = {}) {
  const handlers = {
    onSelect: vi.fn(),
    onActivate: vi.fn(),
    onMark: vi.fn(),
    onToggleGroup: vi.fn(),
    onResize: vi.fn(),
    onSort: vi.fn(),
  };
  let controller: ListController | undefined;
  const element = (props: Props) => (
    <DataGrid<Pod, string>
      label="Pods"
      columns={[{ id: "Name", title: "Name", width: 200, grow: true }]}
      widths={{}}
      sort={null}
      query=""
      {...list(ITEMS)}
      onRange={() => undefined}
      cell={(row) => row.name}
      group={(value) => value}
      selected={undefined}
      marked={new Set()}
      loading={false}
      register={(_, registered) => {
        controller = registered;
        return () => undefined;
      }}
      {...handlers}
      {...props}
    />
  );
  const { rerender } = render(element(overrides));
  return {
    handlers,
    controller: () => controller,
    rerender: (changes: Props) => {
      rerender(element({ ...overrides, ...changes }));
    },
  };
}

test("group headers come before their rows, a failing row has an edge, and a header's click folds it", () => {
  const { handlers } = grid();
  const rows = screen.getAllByRole("row").slice(1);
  expect(rows.map((row) => row.textContent)).toEqual([
    "auth",
    "api-1",
    "api-2",
    "edge",
    "gateway-1",
  ]);
  expect(rows[2]?.className).toContain("var(--error)");
  fireEvent.click(screen.getByText("edge"));
  expect(handlers.onToggleGroup).toHaveBeenCalledWith("g:edge");
});

test("without a header the rows start at the top and count from one", () => {
  grid({ header: false, ...list(PODS) });
  expect(screen.queryAllByRole("columnheader")).toEqual([]);
  expect(screen.getByRole("grid").getAttribute("aria-rowcount")).toBe(
    String(PODS.length),
  );
  const [first, second] = screen.getAllByRole("row");
  expect(first?.getAttribute("aria-rowindex")).toBe("1");
  expect(second?.getAttribute("aria-rowindex")).toBe("2");
  expect(first?.style.transform).toBe("translateY(0px)");
  expect(second?.style.transform).toBe("translateY(26px)");
});

test("a click selects and opens a row, its box marks it", () => {
  const { handlers } = grid();
  fireEvent.click(screen.getByText("api-1"));
  expect(handlers.onSelect).toHaveBeenCalledWith("a1", { name: "api-1" });
  expect(handlers.onActivate).toHaveBeenCalledWith("a1", { name: "api-1" });
  fireEvent.click(
    nth(screen.getAllByRole("checkbox", { name: "Mark row" }), 1),
  );
  expect(handlers.onMark).toHaveBeenCalledWith(["a2"], true);
});

test("the controller moves the cursor, marks as it moves, folds back to the header and opens it", () => {
  const { handlers, controller } = grid({ selected: "a1" });
  act(() => {
    controller()?.move(1, true);
  });
  expect(handlers.onSelect).toHaveBeenLastCalledWith("a2", { name: "api-2" });
  expect(handlers.onMark).toHaveBeenLastCalledWith(["a1", "a2"], true);
  act(() => {
    controller()?.toggleMark?.();
  });
  expect(handlers.onMark).toHaveBeenLastCalledWith(["a2"], true);
  act(() => {
    controller()?.collapse?.();
  });
  act(() => {
    controller()?.activate();
  });
  expect(handlers.onToggleGroup).toHaveBeenLastCalledWith("g:auth");
});

test("a marking move from a group header marks the row it lands on, never the header", () => {
  const { handlers, controller } = grid({ selected: "a2" });
  act(() => {
    controller()?.move(1);
  });
  act(() => {
    controller()?.move(1, true);
  });
  expect(handlers.onMark.mock.calls).toEqual([[["e1"], true]]);
});

test("once the cursor's row is gone, Enter and X act on no other row, and a marking move marks only where it lands", () => {
  const pods = PODS.slice(0, 4);
  const { handlers, controller, rerender } = grid({
    ...list(pods),
    selected: "p2",
  });
  rerender(list(pods.filter((pod) => pod.id !== "p2")));
  act(() => {
    controller()?.activate();
  });
  act(() => {
    controller()?.toggleMark?.();
  });
  expect(handlers.onActivate).not.toHaveBeenCalled();
  expect(handlers.onMark).not.toHaveBeenCalled();
  act(() => {
    controller()?.move(1, true);
  });
  expect(handlers.onMark).toHaveBeenCalledWith(["p3"], true);
});

test("a marking move marks the row it left if the list still has it when the move lands", () => {
  const four = PODS.slice(0, 4);
  const { handlers, controller, rerender } = grid({
    ...list(four),
    selected: "p2",
  });
  rerender(list(four.map((pod) => (pod.id >= "p2" ? undefined : pod))));
  act(() => {
    controller()?.move(1, true);
  });
  expect(handlers.onMark).not.toHaveBeenCalled();
  rerender(list(four));
  expect(handlers.onMark).toHaveBeenCalledWith(["p2", "p3"], true);
});

test("a marking move waits for the row it left when only that row is outside the loaded window", () => {
  const four = PODS.slice(0, 4);
  const { handlers, controller, rerender } = grid({
    ...list(four),
    selected: "p2",
  });
  rerender(list(four.map((pod) => (pod.id <= "p2" ? undefined : pod))));
  act(() => {
    controller()?.move(1, true);
  });
  expect(handlers.onMark).not.toHaveBeenCalled();
  rerender(list(four));
  expect(handlers.onMark).toHaveBeenCalledWith(["p2", "p3"], true);
});

test("a click while a move waits for its row drops the move", () => {
  const four = PODS.slice(0, 4);
  const { handlers, controller, rerender } = grid({
    ...list(four),
    selected: "p2",
  });
  rerender(list(four.map((pod) => (pod.id === "p3" ? undefined : pod))));
  act(() => {
    controller()?.move(1);
  });
  fireEvent.click(screen.getByText("pod-0"));
  rerender(list(four));
  expect(handlers.onSelect).toHaveBeenLastCalledWith("p0", { name: "pod-0" });
});

test("a click on the cursor's own row also drops a move waiting for its row", () => {
  const four = PODS.slice(0, 4);
  const { handlers, controller, rerender } = grid({
    ...list(four),
    selected: "p2",
  });
  rerender(list(four.map((pod) => (pod.id === "p3" ? undefined : pod))));
  act(() => {
    controller()?.move(1);
  });
  fireEvent.click(screen.getByText("pod-2"));
  rerender(list(four));
  expect(handlers.onSelect).toHaveBeenCalledOnce();
  expect(handlers.onSelect).toHaveBeenCalledWith("p2", { name: "pod-2" });
});

function waiting(overrides: Props = {}, extend = false) {
  const four = PODS.slice(0, 4);
  const view = grid({ ...list(four), selected: "p2", ...overrides });
  view.rerender(list(four.map((pod) => (pod.id === "p3" ? undefined : pod))));
  act(() => {
    view.controller()?.move(1, extend);
  });
  const arrive = (changes: Props = {}) => {
    view.rerender({ ...list(four), ...changes });
  };
  return { ...view, arrive };
}

test("a cursor the owner moves drops a move waiting for its row", () => {
  const { handlers, arrive } = waiting();
  arrive({ selected: "p0" });
  expect(handlers.onSelect).not.toHaveBeenCalled();
});

test("a press anywhere in the grid, a sort included, drops a move waiting for its row", () => {
  const { handlers, arrive } = waiting();
  fireEvent.pointerDown(screen.getByRole("button", { name: /^Name/ }));
  arrive();
  expect(handlers.onSelect).not.toHaveBeenCalled();
});

test("Enter while a move waits opens the row the cursor shows, and drops the move", () => {
  const { handlers, controller, arrive } = waiting();
  act(() => {
    controller()?.activate();
  });
  arrive();
  expect(handlers.onActivate).toHaveBeenCalledWith("p2", { name: "pod-2" });
  expect(handlers.onSelect).not.toHaveBeenCalled();
});

test("X, a fold and an unfold while a move waits drop the move", () => {
  for (const key of ["toggleMark", "collapse", "expand"] as const) {
    const { handlers, controller, arrive } = waiting();
    act(() => {
      controller()?.[key]?.();
    });
    arrive();
    expect(handlers.onSelect).not.toHaveBeenCalled();
    cleanup();
  }
});

test("marks cleared or a query changed while a move waits drop the move", () => {
  const marked = waiting({ marked: new Set(["p1", "p2"]) }, true);
  marked.arrive({ marked: new Set() });
  expect(marked.handlers.onMark).not.toHaveBeenCalled();
  cleanup();
  const queried = waiting();
  queried.arrive({ query: "Failing" });
  expect(queried.handlers.onSelect).not.toHaveBeenCalled();
});

test("a marking move onto a group header marks the row it left", () => {
  const { handlers, controller } = grid({ selected: "a2" });
  act(() => {
    controller()?.move(1, true);
  });
  act(() => {
    controller()?.move(1, true);
  });
  expect(handlers.onMark.mock.calls).toEqual([
    [["a2"], true],
    [["e1"], true],
  ]);
});

test("a marking move from a cursor the grid never saw lands at once and marks where it lands", () => {
  const { handlers, controller } = grid({
    ...list(PODS.slice(0, 4)),
    selected: "p9",
  });
  act(() => {
    controller()?.move(1, true);
  });
  expect(handlers.onMark).toHaveBeenCalledWith(["p0"], true);
});

test("a marking move from a cursor the list lost past its end marks only where it lands", () => {
  const { handlers, controller, rerender } = grid({
    ...list(PODS.slice(0, 4)),
    selected: "p3",
  });
  rerender(list(PODS.slice(0, 3)));
  act(() => {
    controller()?.move(-1, true);
  });
  expect(handlers.onMark).toHaveBeenCalledWith(["p2"], true);
});

test("a right click opens a row's menu, but neither on a group header nor on a row still loading", () => {
  const menu = [[{ id: "delete", label: "Delete", run: vi.fn() }]];
  grid({ ...list([...ITEMS, undefined]), selected: "a1", menu });
  fireEvent.contextMenu(screen.getByText("edge"));
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.contextMenu(nth(screen.getAllByRole("row"), ITEMS.length + 1));
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.contextMenu(screen.getByText("gateway-1"));
  expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
});

test("a move to a row still loading is dropped once the list no longer reaches it", () => {
  const loaded = (length: number) =>
    list(
      PODS.slice(0, length).map((pod, index) => (index < 30 ? pod : undefined)),
    );
  const { handlers, controller, rerender } = grid(loaded(100));
  act(() => {
    controller()?.moveToEdge("last");
  });
  rerender(loaded(50));
  rerender(list(PODS));
  expect(handlers.onSelect).not.toHaveBeenCalled();
});

test("without a cursor, a move lands on the first row below the header", () => {
  const { handlers, controller } = grid(list(PODS));
  scroll(scrollable(PODS.length), 1040);
  act(() => {
    controller()?.move(1);
  });
  expect(handlers.onSelect).toHaveBeenLastCalledWith("p40", {
    name: "pod-40",
  });
});

test("the cursor is the grid's active descendant, and the marked rows are the selected ones while there are any", () => {
  const { controller, rerender } = grid({ selected: "a1" });
  const active = () => {
    const id = screen.getByRole("grid").getAttribute("aria-activedescendant");
    return id === null ? undefined : document.getElementById(id)?.textContent;
  };
  const selected = () =>
    screen
      .getAllByRole("row")
      .filter((row) => row.getAttribute("aria-selected") === "true")
      .map((row) => row.textContent);
  expect(active()).toBe("api-1");
  expect(selected()).toEqual(["api-1"]);
  act(() => {
    controller()?.move(2);
  });
  expect(active()).toBe("edge");
  expect(selected()).toEqual(["edge"]);
  rerender({ marked: new Set(["a2", "e1"]) });
  expect(active()).toBe("edge");
  expect(selected()).toEqual(["api-2", "gateway-1"]);
  expect(
    screen
      .getAllByRole("row")
      .filter((row) => row.hasAttribute("data-cursor"))
      .map((row) => row.textContent),
  ).toEqual(["edge"]);
});

test("whatever a row holds sits in one of its cells", () => {
  grid({
    ...list([...ITEMS, undefined]),
    columns: [{ id: "Name", title: "Name", width: 200 }],
    marked: new Set(["a1"]),
    inline: [{ id: "copy", label: "Copy Name", icon: Copy, run: vi.fn() }],
  });
  const [header, ...rows] = screen.getAllByRole("row");
  for (const row of rows)
    for (const child of row.children)
      expect(child.getAttribute("role")).toBe("gridcell");
  expect(rows[rows.length - 1]?.children).toHaveLength(
    header?.children.length ?? 0,
  );
  expect(
    screen
      .getByRole("checkbox", { name: "Clear marks" })
      .closest('[role="columnheader"]'),
  ).not.toBeNull();
  expect(
    header?.lastElementChild?.previousElementSibling?.getAttribute("role"),
  ).toBe("columnheader");
});

test("a move down scrolls the cursor's row clear of the bottom, a move up clear of the sticky header", () => {
  const { controller } = grid({ ...list(PODS), selected: "p22" });
  const element = scrollable(PODS.length);
  act(() => {
    controller()?.move(1);
  });
  expect(element.scrollTop).toBe(52);
  cleanup();

  const again = grid({ ...list(PODS), selected: "p10" });
  const scrolled = scrollable(PODS.length);
  scroll(scrolled, 270);
  act(() => {
    again.controller()?.move(-1);
  });
  expect(scrolled.scrollTop).toBe(234);
});

test("a hovered row's actions run on that row, which they select first, without opening it", () => {
  let selection = "a1";
  const ranOn: string[] = [];
  const { handlers } = grid({
    selected: selection,
    onSelect: (id: string) => {
      selection = id;
    },
    inline: [
      {
        id: "copy",
        label: "Copy Name",
        icon: Copy,
        run: () => {
          ranOn.push(selection);
        },
      },
    ],
  });
  fireEvent.pointerEnter(rowNamed("gateway-1"));
  fireEvent.click(
    within(rowNamed("gateway-1")).getByRole("button", { name: "Copy Name" }),
  );
  expect(ranOn).toEqual(["e1"]);
  expect(handlers.onActivate).not.toHaveBeenCalled();
});

test("a row's actions mount only while the pointer, the focus or the cursor is on it", () => {
  grid({
    selected: "a1",
    menu: [[{ id: "copy", label: "Copy Name", run: vi.fn() }]],
    inline: [{ id: "copy", label: "Copy Name", icon: Copy, run: vi.fn() }],
  });
  const hasActions = (name: string) =>
    within(rowNamed(name)).queryByRole("button", { name: "Row actions" }) !==
    null;
  expect(hasActions("api-1")).toBe(true);
  expect(hasActions("gateway-1")).toBe(false);

  fireEvent.pointerEnter(rowNamed("gateway-1"));
  expect(hasActions("gateway-1")).toBe(true);
  fireEvent.pointerLeave(rowNamed("gateway-1"));
  expect(hasActions("gateway-1")).toBe(false);

  fireEvent.focus(rowNamed("gateway-1"));
  expect(hasActions("gateway-1")).toBe(true);
  fireEvent.blur(rowNamed("gateway-1"));
  expect(hasActions("gateway-1")).toBe(false);
});

test("a row's menu has a column of its own, unless the grid lays it over the row's end", () => {
  const menu = [[{ id: "copy", label: "Copy Name", run: vi.fn() }]];
  const tracks = (name: string) =>
    rowNamed(name).style.gridTemplateColumns.split(" ");
  const actionsCell = (name: string) => {
    fireEvent.pointerEnter(rowNamed(name));
    return within(rowNamed(name))
      .getByRole("button", { name: "Row actions" })
      .closest<HTMLElement>('[role="gridcell"]');
  };

  const least = (name: string) => rowNamed(name).parentElement?.style.minWidth;

  grid({ menu });
  expect(tracks("gateway-1").pop()).toBe("32px");
  expect(least("gateway-1")).toBe("260px");
  expect(actionsCell("gateway-1")?.className).not.toContain("absolute");
  cleanup();

  grid({ menu, overlayMenu: true });
  expect(tracks("gateway-1")).toEqual(["28px", "minmax(200px,", "1fr)"]);
  expect(least("gateway-1")).toBe("228px");
  const cell = actionsCell("gateway-1");
  expect(rowNamed("gateway-1").children).toHaveLength(3);
  expect(cell?.className).toContain("absolute");
  expect(cell?.className).toContain("opacity-0");
  expect(cell?.className).toContain("group-hover/row:opacity-100");
});

test("a grid that lays its row menu over the rows has no column for it in the header, nor in a row still loading", () => {
  const cells = (props: Props) => {
    grid({ ...props, ...list([undefined, ...ITEMS]) });
    const [header, pending] = screen.getAllByRole("row");
    const counts = [header?.children.length, pending?.children.length];
    cleanup();
    return counts;
  };
  const beside = cells({});
  expect(cells({ overlayMenu: true })).toEqual(beside.map((n) => (n ?? 0) - 1));
});

test("a menu laid over a row opens from its button and runs a choice without opening the row", async () => {
  const run = vi.fn();
  const { handlers } = grid({
    overlayMenu: true,
    menu: [[{ id: "copy", label: "Copy Name", run }]],
  });
  fireEvent.pointerEnter(rowNamed("gateway-1"));
  fireEvent.pointerDown(screen.getByRole("button", { name: "Row actions" }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(screen.getByRole("menuitem", { name: "Copy Name" }));
  await act(() => new Promise((resolve) => setTimeout(resolve)));
  expect(run).toHaveBeenCalledOnce();
  expect(handlers.onActivate).not.toHaveBeenCalled();
});

test("a laid-over menu shows only on hover or focus, also on the cursor's row, and takes that row's tint", () => {
  grid({
    overlayMenu: true,
    selected: "a1",
    menu: [[{ id: "copy", label: "Copy Name", run: vi.fn() }]],
  });
  const cell = (name: string) =>
    within(rowNamed(name))
      .queryByRole("button", { name: "Row actions" })
      ?.closest<HTMLElement>('[role="gridcell"]');
  expect(cell("gateway-1")).toBeUndefined();
  const cursor = cell("api-1");
  expect(cursor?.className).toContain("opacity-0");
  expect(cursor?.className).toContain("focus-within:opacity-100");
  expect(cursor?.firstElementChild?.className).toContain(
    "bg-selected-unfocused",
  );
  fireEvent.pointerEnter(rowNamed("gateway-1"));
  expect(cell("gateway-1")?.firstElementChild?.className).toContain(
    "bg-row-hover",
  );
});

test("the focus moving within a row keeps its actions", () => {
  grid({ menu: [[{ id: "copy", label: "Copy Name", run: vi.fn() }]] });
  const row = rowNamed("gateway-1");
  fireEvent.focus(row);
  const actions = within(row).getByRole("button", { name: "Row actions" });
  fireEvent.blur(within(row).getByRole("checkbox"), {
    relatedTarget: actions,
  });
  expect(actions.isConnected).toBe(true);
});

test("a row's menu stays open after the pointer leaves the row", () => {
  grid({ menu: [[{ id: "copy", label: "Copy Name", run: vi.fn() }]] });
  fireEvent.pointerEnter(rowNamed("gateway-1"));
  fireEvent.pointerDown(screen.getByRole("button", { name: "Row actions" }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.pointerLeave(rowNamed("gateway-1"));
  expect(screen.getByRole("menuitem", { name: "Copy Name" })).toBeTruthy();
});

test("a choice in a row's menu runs without opening the row", async () => {
  const run = vi.fn();
  const { handlers } = grid({
    menu: [[{ id: "copy", label: "Copy Name", run }]],
  });
  fireEvent.pointerEnter(rowNamed("gateway-1"));
  fireEvent.pointerDown(screen.getByRole("button", { name: "Row actions" }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(screen.getByRole("menuitem", { name: "Copy Name" }));
  await act(() => new Promise((resolve) => setTimeout(resolve)));
  expect(run).toHaveBeenCalledOnce();
  expect(handlers.onActivate).not.toHaveBeenCalled();
});

test("a right click in a row's menu opens no other menu", async () => {
  grid({ menu: [[{ id: "copy", label: "Copy Name", run: vi.fn() }]] });
  fireEvent.pointerEnter(rowNamed("gateway-1"));
  fireEvent.pointerDown(screen.getByRole("button", { name: "Row actions" }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.contextMenu(screen.getByRole("menuitem", { name: "Copy Name" }));
  await act(() => new Promise((resolve) => setTimeout(resolve)));
  expect(
    document.querySelector('[data-slot="context-menu-content"]'),
  ).toBeNull();
});

test("a header is a column header with a button that sorts, and a double click on its edge fits the column", () => {
  const { handlers } = grid({ sort: { column: "Name", descending: false } });
  const [header] = screen.getAllByRole("row");
  for (const child of header?.children ?? [])
    expect(child.getAttribute("role")).toBe("columnheader");
  const name = screen.getByRole("columnheader", { name: "Name" });
  expect(name.getAttribute("aria-sort")).toBe("ascending");
  fireEvent.click(within(name).getByRole("button", { name: "Name" }));
  expect(handlers.onSort).toHaveBeenCalledWith({
    column: "Name",
    descending: true,
  });
  fireEvent.doubleClick(screen.getByRole("separator", { name: "Resize Name" }));
  expect(handlers.onResize).toHaveBeenCalledWith("Name", expect.any(Number));
});

test("loading shows skeleton rows, and an empty grid what its owner gives", () => {
  grid({ loading: true });
  expect(document.querySelector("[aria-busy]")).not.toBeNull();
  cleanup();
  grid({ length: 0, empty: <p>No pods</p> });
  expect(screen.getByText("No pods")).toBeTruthy();
});

test("a selected or marked row keeps its tint under the pointer, the others take the hover", () => {
  grid({ selected: "a1", marked: new Set(["e1"]) });
  const row = (text: string) =>
    screen.getByText(text).closest<HTMLElement>("[role=row]")?.className;
  expect(row("api-1")).not.toContain("hover:bg-row-hover");
  expect(row("gateway-1")).not.toContain("hover:bg-row-hover");
  expect(row("api-2")).toContain("hover:bg-row-hover");
});
