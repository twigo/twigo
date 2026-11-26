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
import { resize } from "../../test/resize";
import type { ListController } from "../lib/list";
import { DataGrid } from "./DataGrid";
import type { GridItem, RowFlash } from "./types";

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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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
    value: 28 + rows * 24,
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

test("a column that descends first sorts descending on a first click and ascending on the next, and others ascend first", () => {
  const columns = [
    { id: "Name", title: "Name", width: 200, grow: true },
    { id: "CPU", title: "CPU", width: 80, descendFirst: true },
  ];
  const sorter = (name: string) =>
    within(screen.getByRole("columnheader", { name })).getByRole("button");
  const { handlers, rerender } = grid({
    columns,
    sort: { column: "Name", descending: false },
  });
  fireEvent.click(sorter("CPU"));
  expect(handlers.onSort).toHaveBeenLastCalledWith({
    column: "CPU",
    descending: true,
  });
  rerender({ columns, sort: { column: "CPU", descending: true } });
  fireEvent.click(sorter("CPU"));
  expect(handlers.onSort).toHaveBeenLastCalledWith({
    column: "CPU",
    descending: false,
  });
  rerender({ columns, sort: { column: "CPU", descending: false } });
  fireEvent.click(sorter("CPU"));
  expect(handlers.onSort).toHaveBeenLastCalledWith({
    column: "CPU",
    descending: true,
  });
  rerender({ columns, sort: { column: "CPU", descending: true } });
  fireEvent.click(sorter("Name"));
  expect(handlers.onSort).toHaveBeenLastCalledWith({
    column: "Name",
    descending: false,
  });
});

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

test("group headers come before their rows, a failing row is a band in its tone, and a header's click folds it", () => {
  const { handlers } = grid();
  const rows = screen.getAllByRole("row").slice(1);
  expect(rows.map((row) => row.textContent)).toEqual([
    "auth",
    "api-1",
    "api-2",
    "edge",
    "gateway-1",
  ]);
  expect(rows[2]?.getAttribute("data-tone")).toBe("error");
  expect(rows[2]?.className).toContain("bg-(--band)");
  expect(rows[1]?.hasAttribute("data-tone")).toBe(false);
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
  expect(second?.style.transform).toBe("translateY(24px)");
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
  scroll(scrollable(PODS.length), 960);
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
    inline: () => [
      { id: "copy", label: "Copy Name", icon: Copy, run: vi.fn() },
    ],
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
  const { controller } = grid({ ...list(PODS), selected: "p24" });
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
  expect(scrolled.scrollTop).toBe(216);
});

const WITH_AGE = [
  { id: "Name", title: "Name", width: 200, grow: true },
  { id: "Status", title: "Status", width: 120 },
  { id: "Age", title: "Age", width: 64, coverable: true },
];

const nameOnly = (row: Pod, column: { id: string }) =>
  column.id === "Name" ? row.name : "";

const rest = (ms = 70) =>
  act(() => new Promise((resolve) => setTimeout(resolve, ms)));

test("a hovered row's icons are its own actions and run on that row, which they select first, without opening it", async () => {
  let selection = "a1";
  const ranOn: string[] = [];
  const { handlers } = grid({
    columns: WITH_AGE,
    cell: nameOnly,
    selected: selection,
    onSelect: (id: string) => {
      selection = id;
    },
    inline: (row) => [
      {
        id: "copy",
        label: "Copy Name",
        icon: Copy,
        run: () => {
          ranOn.push(`${row.name} on ${selection}`);
        },
      },
    ],
  });
  fireEvent.pointerEnter(rowNamed("gateway-1"));
  await rest();
  fireEvent.click(
    within(rowNamed("gateway-1")).getByRole("button", { name: "Copy Name" }),
  );
  expect(ranOn).toEqual(["gateway-1 on e1"]);
  expect(handlers.onActivate).not.toHaveBeenCalled();
});

test("a hovered row's icon names no key, since the key acts on the selected row", async () => {
  grid({
    columns: WITH_AGE,
    cell: nameOnly,
    selected: "a1",
    inline: () => [
      {
        id: "cordon",
        label: "Cordon",
        icon: Copy,
        keys: "⇧C",
        run: vi.fn(),
      },
    ],
  });
  fireEvent.pointerEnter(rowNamed("gateway-1"));
  await rest();
  act(() => {
    within(rowNamed("gateway-1"))
      .getByRole("button", { name: "Cordon" })
      .focus();
  });
  expect(screen.getByRole("tooltip").textContent).toBe("Cordon");
});

test("a hovered row's icons show once the pointer rests on it, and only where the last columns that may be covered have room", async () => {
  const icons = (name: string) =>
    within(rowNamed(name))
      .queryAllByRole("button")
      .map((button) => button.getAttribute("aria-label"))
      .filter((label) => label !== "Row actions");
  const two = () => [
    { id: "logs", label: "Logs", icon: Copy, run: vi.fn() },
    { id: "shell", label: "Shell", icon: Copy, run: vi.fn() },
  ];
  const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
  vi.useFakeTimers();
  grid({ columns: WITH_AGE, cell: nameOnly, inline: two });
  fireEvent.pointerEnter(rowNamed("api-2"));
  await wait(30);
  expect(icons("api-2")).toEqual([]);
  await wait(40);
  expect(icons("api-2")).toEqual(["Logs", "Shell"]);
  fireEvent.pointerLeave(rowNamed("api-2"));
  expect(icons("api-2")).toEqual([]);
  cleanup();

  grid({
    columns: [
      ...WITH_AGE.slice(0, 2),
      { id: "Age", title: "Age", width: 40, coverable: true },
    ],
    cell: nameOnly,
    inline: two,
  });
  fireEvent.pointerEnter(rowNamed("api-2"));
  await wait(70);
  expect(icons("api-2")).toEqual([]);
  cleanup();

  grid({
    columns: [WITH_AGE[0], WITH_AGE[2], WITH_AGE[1]].filter(
      (column) => column !== undefined,
    ),
    cell: nameOnly,
    inline: two,
  });
  fireEvent.pointerEnter(rowNamed("api-2"));
  await wait(70);
  expect(icons("api-2")).toEqual([]);
});

test("a row's actions mount only while the pointer, the focus or the cursor is on it", () => {
  grid({
    selected: "a1",
    menu: [[{ id: "copy", label: "Copy Name", run: vi.fn() }]],
    inline: () => [
      { id: "copy", label: "Copy Name", icon: Copy, run: vi.fn() },
    ],
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

test("the first column stays at the grid's left edge, beside the marks, only while the grid scrolls sideways and the column leaves the row's actions their room", () => {
  const columns = (name: number) => [
    { id: "Name", title: "Name", width: name },
    { id: "Age", title: "Age", width: 100 },
  ];
  const held = () => [
    within(screen.getByRole("columnheader", { name: "Name" })).getByRole(
      "button",
    ).parentElement?.style.left,
    rowNamed("gateway-1").querySelector<HTMLElement>('[data-column="Name"]')
      ?.style.left,
  ];

  const cell = (row: Pod, column: { id: string }) =>
    column.id === "Name" ? row.name : "4d";

  grid({ columns: columns(300), cell });
  act(() => {
    resize();
  });
  expect(held()).toEqual(["", ""]);
  cleanup();

  grid({ columns: columns(900), cell });
  act(() => {
    resize();
  });
  expect(held()).toEqual(["28px", "28px"]);
  cleanup();

  grid({ columns: columns(960), cell });
  act(() => {
    resize();
  });
  expect(held()).toEqual(["", ""]);
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

test("a laid-over menu shows on hover, on focus and while its menu is open, also on the cursor's row, over the grid's surface in its row's tint", () => {
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
  for (const shown of [
    "opacity-0",
    "group-hover/row:opacity-100",
    "focus-within:opacity-100",
    "has-[[data-state=open]]:opacity-100",
    "bg-[var(--surface,var(--editor))]",
  ])
    expect(cursor?.classList.contains(shown)).toBe(true);
  expect(cursor?.firstElementChild?.className).toContain(
    "bg-selected-unfocused",
  );
  fireEvent.pointerEnter(rowNamed("gateway-1"));
  expect(cell("gateway-1")?.firstElementChild?.className).toContain(
    "bg-row-hover",
  );
  const button = within(rowNamed("gateway-1")).getByRole("button", {
    name: "Row actions",
  });
  expect(button.className).not.toContain("opacity");
  fireEvent.pointerDown(button, { button: 0, ctrlKey: false });
  fireEvent.pointerLeave(rowNamed("gateway-1"));
  expect(button.getAttribute("data-state")).toBe("open");
  expect(screen.getByRole("menuitem", { name: "Copy Name" })).toBeTruthy();
});

test("without the overlay a row's button shows on its hover, on the cursor's row, on the keyboard's focus and while its menu is open", () => {
  grid({
    selected: "a1",
    menu: [[{ id: "copy", label: "Copy Name", run: vi.fn() }]],
  });
  const buttonOf = (name: string) =>
    within(rowNamed(name)).getByRole("button", { name: "Row actions" });
  const shown = [
    "group-hover/row:opacity-100",
    "focus-visible:opacity-100",
    "data-[state=open]:opacity-100",
  ];

  fireEvent.pointerEnter(rowNamed("gateway-1"));
  const other = buttonOf("gateway-1");
  expect(other.classList.contains("opacity-0")).toBe(true);
  expect(other.classList.contains("opacity-100")).toBe(false);
  for (const name of shown) expect(other.classList.contains(name)).toBe(true);

  const cursor = buttonOf("api-1");
  expect(cursor.classList.contains("opacity-100")).toBe(true);
  expect(cursor.classList.contains("opacity-0")).toBe(false);
  for (const name of shown) expect(cursor.classList.contains(name)).toBe(true);
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

function doubleClick(target: Element, first: Element = target) {
  fireEvent.mouseDown(first, { detail: 1 });
  fireEvent.mouseUp(first, { detail: 1 });
  fireEvent.mouseDown(target, { detail: 2 });
  fireEvent.mouseUp(target, { detail: 2 });
  fireEvent.doubleClick(target, { detail: 2 });
}

test("a double click opens a row, never a group header, a column's edge or a control in the row, and keeps the second press from selecting text", () => {
  const onOpen = vi.fn();
  const menu = [[{ id: "delete", label: "Delete", run: vi.fn() }]];
  const { handlers } = grid({ onOpen, menu, selected: "a1" });
  doubleClick(screen.getByText("edge"));
  doubleClick(screen.getByRole("separator", { name: "Resize Name" }));
  doubleClick(screen.getByRole("button", { name: "Row actions" }));
  doubleClick(nth(screen.getAllByRole("checkbox"), 1));
  expect(onOpen).not.toHaveBeenCalled();
  expect(handlers.onResize).toHaveBeenCalledOnce();

  doubleClick(screen.getByText("api-2"));
  expect(onOpen).toHaveBeenCalledExactlyOnceWith("a2", { name: "api-2" });

  const row = rowNamed("api-1");
  expect(fireEvent.mouseDown(row, { detail: 1 })).toBe(true);
  expect(fireEvent.mouseDown(row, { detail: 2 })).toBe(false);
  expect(fireEvent.mouseDown(screen.getByText("edge"), { detail: 2 })).toBe(
    true,
  );
});

test("a double click opens a row only when both presses were on it, the next one starting afresh", () => {
  const onOpen = vi.fn();
  grid({ onOpen });
  doubleClick(rowNamed("api-2"), rowNamed("api-1"));
  expect(onOpen).not.toHaveBeenCalled();
  doubleClick(rowNamed("api-1"), rowNamed("api-2"));
  expect(onOpen).not.toHaveBeenCalled();
  doubleClick(rowNamed("api-2"));
  expect(onOpen).toHaveBeenCalledExactlyOnceWith("a2", { name: "api-2" });
});

test("a double click whose first press was off every row opens nothing, though an earlier click was on the row of its second", () => {
  const onOpen = vi.fn();
  grid({ onOpen });
  fireEvent.mouseDown(rowNamed("api-2"), { detail: 1 });
  fireEvent.mouseUp(rowNamed("api-2"), { detail: 1 });
  fireEvent.click(rowNamed("api-2"), { detail: 1 });
  doubleClick(rowNamed("api-2"), screen.getByRole("grid"));
  expect(onOpen).not.toHaveBeenCalled();
  doubleClick(
    rowNamed("api-2"),
    screen.getByRole("columnheader", { name: "Name" }),
  );
  expect(onOpen).not.toHaveBeenCalled();
  doubleClick(rowNamed("api-2"));
  expect(onOpen).toHaveBeenCalledExactlyOnceWith("a2", { name: "api-2" });
});

test("a double click in the mark cell beside its box opens nothing, as on the box", () => {
  const onOpen = vi.fn();
  grid({ onOpen });
  const box = nth(screen.getAllByRole("checkbox"), 1);
  const cell = box.closest<HTMLElement>('[role="gridcell"]');
  if (!cell || cell === box) throw new Error("the box has no cell");
  doubleClick(cell);
  expect(onOpen).not.toHaveBeenCalled();
});

test("a double click in a menu that the row opened reaches the row through its portal and opens nothing", () => {
  const onOpen = vi.fn();
  grid({ onOpen, menu: [[{ id: "delete", label: "Delete", run: vi.fn() }]] });
  fireEvent.pointerEnter(rowNamed("api-1"));
  fireEvent.pointerDown(
    within(rowNamed("api-1")).getByRole("button", { name: "Row actions" }),
    { button: 0, ctrlKey: false },
  );
  const menu = screen.getByRole("menu");
  expect(rowNamed("api-1").contains(menu)).toBe(false);
  fireEvent.mouseDown(rowNamed("api-1"), { detail: 1 });
  fireEvent.doubleClick(menu, { detail: 2 });
  expect(onOpen).not.toHaveBeenCalled();
});

test("without a way to open, a double click on a row does nothing and its second press selects text as usual", () => {
  grid();
  const row = rowNamed("api-1");
  expect(fireEvent.mouseDown(row, { detail: 2 })).toBe(true);
});

test("loading shows skeleton rows, and an empty grid what its owner gives", () => {
  grid({ loading: true });
  expect(document.querySelector("[aria-busy]")).not.toBeNull();
  cleanup();
  grid({ length: 0, empty: <p>No pods</p> });
  expect(screen.getByText("No pods")).toBeTruthy();
});

test("a selected or marked row keeps its tint under the pointer, and a failing one's band gives way to it, the others take the hover", () => {
  grid({ selected: "a2", marked: new Set(["e1"]) });
  const row = (text: string) =>
    screen.getByText(text).closest<HTMLElement>("[role=row]")?.className;
  for (const text of ["api-2", "gateway-1"]) {
    expect(row(text)).not.toContain("hover:bg-");
    expect(row(text)).not.toContain("bg-(--band)");
  }
  expect(row("api-1")).toContain("hover:bg-row-hover");
});

test("a failing row's band and edge reach what covers its cells: the held first cells, the hover icons and the laid-over menu", async () => {
  const columns = [
    { id: "Name", title: "Name", width: 900 },
    { id: "Age", title: "Age", width: 100, coverable: true },
  ];
  const cell = (row: Pod, column: { id: string }) =>
    column.id === "Name" ? row.name : "4d";
  const classes = (element: Element | null | undefined) => [
    ...(element?.classList ?? []),
  ];
  const BAND = [
    "before:bg-(--band)",
    "group-hover/row:before:bg-(image:--row-hover-layer)",
  ];
  const HOVER = ["group-hover/row:before:bg-row-hover"];
  const EDGE = "shadow-[inset_3px_0_0_var(--edge)]";

  grid({
    columns,
    cell,
    inline: () => [
      { id: "copy", label: "Copy Name", icon: Copy, run: vi.fn() },
    ],
  });
  act(() => {
    resize();
  });
  for (const [name, held, edge] of [
    ["api-2", BAND, true],
    ["gateway-1", HOVER, false],
  ] as const) {
    const row = rowNamed(name);
    for (const part of [
      row.querySelector('[role="gridcell"]'),
      row.querySelector('[data-column="Name"]'),
    ]) {
      expect(classes(part)).toEqual(expect.arrayContaining([...held]));
    }
    expect(classes(row.querySelector('[role="gridcell"]')).includes(EDGE)).toBe(
      edge,
    );
  }
  for (const [name, tint] of [
    ["api-2", ["bg-(--band)", "bg-(image:--row-hover-layer)"]],
    ["gateway-1", ["bg-row-hover"]],
  ] as const) {
    fireEvent.pointerEnter(rowNamed(name));
    await rest();
    const icons = within(rowNamed(name))
      .getByRole("button", { name: "Copy Name" })
      .closest(".pl-2");
    expect(classes(icons)).toEqual(expect.arrayContaining([...tint]));
    fireEvent.pointerLeave(rowNamed(name));
  }
  cleanup();

  grid({
    columns,
    cell,
    overlayMenu: true,
    menu: [[{ id: "copy", label: "Copy Name", run: vi.fn() }]],
  });
  for (const [name, tint] of [
    ["api-2", ["bg-(--band)", "bg-(image:--row-hover-layer)"]],
    ["gateway-1", ["bg-row-hover"]],
  ] as const) {
    fireEvent.pointerEnter(rowNamed(name));
    const menu = within(rowNamed(name))
      .getByRole("button", { name: "Row actions" })
      .closest('[role="gridcell"]');
    expect(classes(menu?.firstElementChild)).toEqual(
      expect.arrayContaining([...tint]),
    );
  }
});

test("a column's note is a quiet mark on its header, said in words to a screen reader, and its click still sorts", () => {
  const { handlers } = grid({
    columns: [
      { id: "Name", title: "Name", width: 200, grow: true },
      { id: "CPU", title: "CPU", width: 80, note: "metrics-server is down" },
    ],
  });
  const cpu = screen.getByRole("columnheader", { name: "CPU" });
  const described = cpu.getAttribute("aria-describedby");
  expect(described).not.toBeNull();
  expect(document.getElementById(described ?? "")?.textContent).toBe(
    "metrics-server is down",
  );
  expect(
    screen
      .getByRole("columnheader", { name: "Name" })
      .hasAttribute("aria-describedby"),
  ).toBe(false);
  fireEvent.click(within(cpu).getByRole("button"));
  expect(handlers.onSort).toHaveBeenCalledWith({
    column: "CPU",
    descending: false,
  });
});

test("a header's sort button is the same element with and without a note, so its focus stays", () => {
  const columns = (note?: string) => [
    { id: "Name", title: "Name", width: 200, grow: true },
    { id: "CPU", title: "CPU", width: 80, ...(note && { note }) },
  ];
  const { rerender } = grid({ columns: columns("metrics-server is down") });
  const button = () =>
    within(screen.getByRole("columnheader", { name: "CPU" })).getByRole(
      "button",
    );
  const sorter = button();
  act(() => {
    sorter.focus();
  });
  expect(screen.getByRole("tooltip").textContent).toBe(
    "metrics-server is down",
  );
  rerender({ columns: columns() });
  expect(button()).toBe(sorter);
  expect(document.activeElement).toBe(sorter);
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(
    screen
      .getByRole("columnheader", { name: "CPU" })
      .hasAttribute("aria-describedby"),
  ).toBe(false);
  rerender({ columns: columns("you may not read metrics") });
  expect(button()).toBe(sorter);
  expect(document.activeElement).toBe(sorter);
  expect(
    screen.getByRole("columnheader", { name: "CPU" }).textContent,
  ).toContain("you may not read metrics");
});

const drawn = (cell: { mock: { calls: readonly [Pod, ...unknown[]][] } }) =>
  cell.mock.calls.map(([row]) => row.name);

const NAME_ONLY = [{ id: "Name", title: "Name", width: 200, grow: true }];

test("a scroll that keeps rows in the window draws none of them again, only the rows that enter", () => {
  const cell = vi.fn((row: Pod) => row.name);
  grid({ ...list(PODS), cell });
  const before = drawn(cell);
  expect(before.length).toBeGreaterThan(20);
  cell.mockClear();
  scroll(scrollable(PODS.length), 5 * 24);
  const after = drawn(cell);
  expect(after.length).toBeGreaterThan(0);
  expect(after.filter((name) => before.includes(name))).toEqual([]);
  expect(screen.getByText("pod-6")).toBeTruthy();
});

test("an owner's new handlers, menu and icons draw no row, and the menu a row opens is the new one", () => {
  const cell = vi.fn((row: Pod) => row.name);
  const inline = vi.fn(() => [
    { id: "copy", label: "Copy Name", icon: Copy, run: vi.fn() },
  ]);
  const { rerender } = grid({
    ...list(PODS),
    columns: NAME_ONLY,
    cell,
    selected: "p1",
    menu: [[{ id: "copy", label: "Copy Name", run: vi.fn() }]],
    inline,
  });
  cell.mockClear();
  const runs = vi.fn();
  rerender({
    ...list(PODS),
    onSelect: vi.fn(),
    onActivate: vi.fn(),
    onMark: vi.fn(),
    menu: [[{ id: "paste", label: "Paste Name", run: runs }]],
    inline: () => [],
    flash: () => undefined,
  });
  expect(cell).not.toHaveBeenCalled();
  const button = within(rowNamed("pod-1")).getByRole("button", {
    name: "Row actions",
  });
  fireEvent.pointerDown(button, { button: 0, ctrlKey: false });
  expect(screen.queryByText("Copy Name")).toBeNull();
  expect(screen.getByText("Paste Name")).toBeTruthy();
});

test("a row draws again when its data, its cursor, its mark or its flash changes, and no other row does", () => {
  const cell = vi.fn((row: Pod) => row.name);
  const { rerender } = grid({
    ...list(PODS),
    columns: NAME_ONLY,
    cell,
    selected: "p1",
  });
  let now: Props = {};
  const changes = (more: Props) => {
    cell.mockClear();
    now = { ...now, ...more };
    rerender(now);
    return drawn(cell);
  };

  expect(
    changes(
      list(
        PODS.map((item) =>
          item.type === "row" && item.id === "p3"
            ? { ...item, data: { name: "pod-3" } }
            : item,
        ),
      ),
    ),
  ).toEqual(["pod-3"]);
  expect(changes({ selected: "p5" })).toEqual(["pod-1", "pod-5"]);
  expect(
    changes({ marked: new Set(["p2"]) }).length,
    "the first mark changes what every row says of its selection",
  ).toBeGreaterThan(20);
  expect(changes({ marked: new Set(["p2", "p4"]) })).toEqual(["pod-4"]);
  expect(changes({ flash: (id) => (id === "p7" ? FLASH : undefined) })).toEqual(
    ["pod-7"],
  );
  expect(
    rowNamed("pod-7").querySelector('[data-column="Name"] > span')?.className,
  ).toContain("animate-flash");
  expect(
    changes({ flash: (id) => (id === "p7" ? FLASH : undefined) }),
    "the same flash",
  ).toEqual([]);
  expect(
    changes({ columns: [...NAME_ONLY] }).length,
    "new columns",
  ).toBeGreaterThan(20);
});

const FLASH: RowFlash = new Map([["Name", 1]]);

test("a row calls the owner's current handlers, not those of the render that drew it", () => {
  const handlers = () => ({
    onSelect: vi.fn(),
    onActivate: vi.fn(),
    onMark: vi.fn(),
    onOpen: vi.fn(),
  });
  const before = handlers();
  const now = handlers();
  const { rerender, controller } = grid({
    ...before,
    columns: NAME_ONLY,
    cell: (row) => row.name,
  });
  rerender(now);

  fireEvent.click(screen.getByText("api-1"));
  expect(now.onSelect).toHaveBeenLastCalledWith("a1", { name: "api-1" });
  expect(now.onActivate).toHaveBeenLastCalledWith("a1", { name: "api-1" });
  now.onActivate.mockClear();
  act(() => {
    controller()?.activate();
  });
  expect(now.onActivate).toHaveBeenLastCalledWith("a1", { name: "api-1" });
  fireEvent.click(
    nth(screen.getAllByRole("checkbox", { name: "Mark row" }), 1),
  );
  expect(now.onMark).toHaveBeenLastCalledWith(["a2"], true);
  doubleClick(screen.getByText("api-2"));
  expect(now.onOpen).toHaveBeenCalledExactlyOnceWith("a2", { name: "api-2" });

  for (const handler of Object.values(before)) {
    expect(handler).not.toHaveBeenCalled();
  }
});

test("a row's rest calls the owner's current onRest, not the one of the render that drew it", async () => {
  const before = vi.fn(() => vi.fn());
  const now = vi.fn(() => vi.fn());
  const { rerender } = grid({
    columns: WITH_AGE,
    cell: nameOnly,
    inline: () => [
      { id: "copy", label: "Copy Name", icon: Copy, run: vi.fn() },
    ],
    onRest: before,
  });
  rerender({ onRest: now });
  fireEvent.pointerEnter(rowNamed("gateway-1"));
  await rest();
  expect(now).toHaveBeenCalledExactlyOnceWith({ name: "gateway-1" });
  expect(before).not.toHaveBeenCalled();
});

test("a row draws again when the cell renderer, its tone or the grid's template changes, though its data does not", () => {
  const read = (row: Pod) => row.name;
  const cell = vi.fn(read);
  const renewed = vi.fn(read);
  const { rerender } = grid({
    ...list(PODS),
    columns: [{ id: "Name", title: "Name", width: 200 }],
    cell,
  });
  const shown = screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.textContent);
  expect(shown.length).toBeGreaterThan(20);
  let now: Props = {};
  const changes = (more: Props) => {
    renewed.mockClear();
    now = { ...now, ...more };
    rerender(now);
    return drawn(renewed);
  };

  expect(changes({ cell: renewed }), "a new cell renderer").toEqual(shown);
  expect(
    changes(list(PODS.map((item) => ({ ...item, tone: "warn" as const })))),
    "a new tone",
  ).toEqual(shown);
  expect(changes({ widths: { Name: 300 } }), "a new template").toEqual(shown);
});
