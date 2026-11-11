import type { ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { notify } from "@twigo/ui";
import { testWorkbench } from "../testing";
import { WorkbenchView } from "../WorkbenchView";

const dragEnds = vi.hoisted(
  () => new Map<"rows" | "columns", (sizes: number[]) => void>(),
);
const layouts = vi.hoisted(
  () => new Map<"rows" | "columns", (sizes: number[]) => void>(),
);

vi.mock("allotment", () => {
  function Allotment({
    children,
    vertical,
    onDragEnd,
    onChange,
  }: {
    children: ReactNode;
    vertical?: boolean;
    onDragEnd?: (sizes: number[]) => void;
    onChange?: (sizes: number[]) => void;
  }) {
    if (onDragEnd) dragEnds.set(vertical ? "rows" : "columns", onDragEnd);
    if (onChange) layouts.set(vertical ? "rows" : "columns", onChange);
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

const lay = (split: "rows" | "columns", measured: number[]) => {
  act(() => {
    layouts.get(split)?.(measured);
  });
};

const drag = (split: "rows" | "columns", measured: number[]) => {
  act(() => {
    dragEnds.get(split)?.(measured);
  });
};

test("dragged part sizes are the app's: they stay as spaces switch, and come back in the next window", async () => {
  const workbench = await testWorkbench();
  render(<WorkbenchView workbench={workbench} />);
  expect(sizes()).toEqual([260, 340, 300]);

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

test("toasts stay above the panel's tab strip as far up as the panel measures while it shows, at the status bar's edge once it is hidden or maximized, and under the title bar", async () => {
  const workbench = await testWorkbench();
  render(<WorkbenchView workbench={workbench} />);
  const space = workbench.spaces.active?.id ?? "";
  act(() => {
    notify.warning("Held");
  });
  await screen.findByText("Held");
  const placed = () => {
    const bottom =
      document
        .querySelector<HTMLElement>("[data-sonner-toaster]")
        ?.style.getPropertyValue("--offset-bottom") ?? "";
    const match =
      /^max\(32px, min\((\d+)px, calc\(100dvh - (\d+)px\)\)\)$/.exec(bottom);
    if (!match) throw new Error(`not a clamped offset: ${bottom}`);
    return { above: Number(match[1]), under: Number(match[2]) };
  };
  lay("rows", [700, 0]);
  expect(placed()).toEqual({ above: 32, under: 44 });

  act(() => {
    workbench.spaces.setPart(space, "panel", { visible: true });
  });
  lay("rows", [400, 300]);
  expect(placed()).toEqual({ above: 332, under: 44 });
  lay("rows", [300, 399.6]);
  expect(placed()).toEqual({ above: 432, under: 44 });

  act(() => {
    workbench.spaces.setPart(space, "panel", { maximized: true });
  });
  lay("rows", [0, 700]);
  expect(placed()).toEqual({ above: 32, under: 44 });

  act(() => {
    workbench.spaces.setPart(space, "panel", {
      visible: false,
      maximized: false,
    });
  });
  lay("rows", [700, 0]);
  expect(placed()).toEqual({ above: 32, under: 44 });
  expect([
    ...(document.querySelector(".twigo-titlebar")?.classList ?? []),
  ]).toContain("h-9");
});
