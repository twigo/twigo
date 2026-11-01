import type { ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { testWorkbench } from "../testing";
import { WorkbenchView } from "../WorkbenchView";

const dragEnds = vi.hoisted(
  () => new Map<"rows" | "columns", (sizes: number[]) => void>(),
);

vi.mock("allotment", () => {
  function Allotment({
    children,
    vertical,
    onDragEnd,
  }: {
    children: ReactNode;
    vertical?: boolean;
    onDragEnd?: (sizes: number[]) => void;
  }) {
    if (onDragEnd) dragEnds.set(vertical ? "rows" : "columns", onDragEnd);
    return <div>{children}</div>;
  }
  Allotment.Pane = function Pane({
    children,
    preferredSize,
  }: {
    children: ReactNode;
    preferredSize?: number;
  }) {
    return <div data-size={preferredSize}>{children}</div>;
  };
  return { Allotment, LayoutPriority: { High: "HIGH" } };
});

afterEach(cleanup);

const sizes = () =>
  [...document.querySelectorAll("[data-size]")].map((pane) =>
    Number(pane.getAttribute("data-size")),
  );

const drag = (split: "rows" | "columns", measured: number[]) => {
  act(() => {
    dragEnds.get(split)?.(measured);
  });
};

test("dragged part sizes are the app's: they stay as spaces switch, and come back in the next window", async () => {
  const workbench = await testWorkbench();
  render(<WorkbenchView workbench={workbench} />);
  expect(sizes()).toEqual([260, 240, 300]);

  drag("columns", [300.4, 900, 0]);
  drag("rows", [500, 199.6]);
  expect(sizes()).toEqual([300, 200, 300]);
  expect(workbench.sizes.get("secondary")).toBeUndefined();

  act(() => {
    workbench.spaces.select("staging");
  });
  expect(sizes()).toEqual([300, 200, 300]);

  await act(() => workbench.state.settled());
  cleanup();
  const next = await testWorkbench("ready", workbench.backend);
  render(<WorkbenchView workbench={next} />);
  expect(sizes()).toEqual([300, 200, 300]);
});
