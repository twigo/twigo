import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import type { ListController } from "../lib/list";
import { Tree, type TreeRow } from "./Tree";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterAll(() => {
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

afterEach(cleanup);

const ROWS: readonly TreeRow[] = [
  { id: "heading", depth: 0, label: "Pinned", heading: true },
  { id: "failing", depth: 0, label: "Failing pods" },
  { id: "workloads", depth: 0, label: "Workloads", open: true },
  { id: "pods", parent: "workloads", depth: 1, label: "Pods" },
  { id: "config", depth: 0, label: "Config", open: false },
];

function tree() {
  const onOpen = vi.fn();
  const onToggle = vi.fn();
  let controller: ListController | undefined;
  render(
    <Tree
      label="Resources"
      rows={ROWS}
      onOpen={onOpen}
      onToggle={onToggle}
      register={(_, registered) => {
        controller = registered;
        return () => undefined;
      }}
    />,
  );
  return { onOpen, onToggle, controller: () => controller };
}

test("a click folds a section and opens a leaf, a double click keeps it", () => {
  const { onOpen, onToggle } = tree();
  fireEvent.click(screen.getByText("Config"));
  expect(onToggle).toHaveBeenCalledWith("config");
  fireEvent.click(screen.getByText("Pods"));
  expect(onOpen).toHaveBeenLastCalledWith("pods", false);
  fireEvent.doubleClick(screen.getByText("Pods"));
  expect(onOpen).toHaveBeenLastCalledWith("pods", true);
  expect(screen.queryByRole("treeitem", { name: /Pinned/ })).toBeNull();
});

test("before the cursor reaches a row, the active descendant is no heading", () => {
  tree();
  expect(
    screen.getByRole("tree").getAttribute("aria-activedescendant"),
  ).toBeNull();
});

test("the cursor passes headings by, Left goes to the parent, Right opens a closed section", () => {
  const { onOpen, onToggle, controller } = tree();
  act(() => {
    controller()?.moveToEdge("first");
  });
  act(() => {
    controller()?.activate();
  });
  expect(onOpen).toHaveBeenLastCalledWith("failing", false);
  act(() => {
    controller()?.move(2);
  });
  act(() => {
    controller()?.collapse?.();
  });
  act(() => {
    controller()?.collapse?.();
  });
  expect(onToggle).toHaveBeenLastCalledWith("workloads");
  act(() => {
    controller()?.moveToEdge("last");
  });
  act(() => {
    controller()?.expand?.();
  });
  expect(onToggle).toHaveBeenLastCalledWith("config");
});

test("the active row keeps its tint under the pointer, the others take the hover", () => {
  render(
    <Tree
      label="Resources"
      rows={ROWS}
      active="pods"
      onOpen={vi.fn()}
      onToggle={vi.fn()}
    />,
  );
  const row = (name: string) => screen.getByRole("treeitem", { name });
  expect(row("Pods").className).not.toContain("hover:bg-row-hover");
  expect(row("Failing pods").className).toContain("hover:bg-row-hover");
});
