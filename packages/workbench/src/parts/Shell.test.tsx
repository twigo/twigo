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

test("dragged part sizes are saved per space and read back with it", async () => {
  const workbench = await testWorkbench();
  render(<WorkbenchView workbench={workbench} />);
  expect(sizes()).toEqual([260, 240, 300]);

  drag("columns", [300.4, 900, 0]);
  drag("rows", [500, 199.6]);
  expect(workbench.spaces.state("prod-eu").parts).toMatchObject({
    sidebar: { size: 300 },
    panel: { size: 200 },
    secondary: { size: undefined },
  });
  expect(sizes()).toEqual([300, 200, 300]);

  act(() => {
    workbench.spaces.select("staging");
  });
  expect(sizes()).toEqual([260, 240, 300]);
  act(() => {
    workbench.spaces.select("prod-eu");
  });
  expect(sizes()).toEqual([300, 200, 300]);
});
