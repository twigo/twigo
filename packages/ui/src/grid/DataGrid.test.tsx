import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
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

function grid(
  overrides: Partial<Parameters<typeof DataGrid<Pod, string>>[0]> = {},
) {
  const handlers = {
    onSelect: vi.fn(),
    onActivate: vi.fn(),
    onMark: vi.fn(),
    onToggleGroup: vi.fn(),
    onResize: vi.fn(),
    onSort: vi.fn(),
  };
  let controller: ListController | undefined;
  render(
    <DataGrid<Pod, string>
      label="Pods"
      columns={[{ id: "Name", title: "Name", width: 200, grow: true }]}
      widths={{}}
      sort={null}
      length={ITEMS.length}
      item={(index) => ITEMS[index]}
      indexOf={(id) => ITEMS.findIndex((item) => item.id === id)}
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
      {...overrides}
    />,
  );
  return { handlers, controller: () => controller };
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

test("a hovered row's actions run on that row", () => {
  const run = vi.fn();
  const { handlers } = grid({
    inline: [{ id: "copy", label: "Copy Name", icon: Copy, run }],
  });
  fireEvent.click(nth(screen.getAllByRole("button", { name: "Copy Name" }), 2));
  expect(handlers.onSelect).toHaveBeenLastCalledWith("e1", {
    name: "gateway-1",
  });
  expect(run).toHaveBeenCalledOnce();
});

test("a header sorts, and a double click on its edge fits the column", () => {
  const { handlers } = grid();
  fireEvent.click(screen.getByRole("columnheader", { name: "Name" }));
  expect(handlers.onSort).toHaveBeenCalledWith({
    column: "Name",
    descending: false,
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
