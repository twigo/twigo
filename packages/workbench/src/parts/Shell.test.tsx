import type { ReactNode, RefObject } from "react";
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
const dragStarts = vi.hoisted(
  () => new Map<"rows" | "columns", (sizes: number[]) => void>(),
);
const resets = vi.hoisted(() => new Map<"rows" | "columns", () => void>());
const resize = vi.hoisted(() => vi.fn<(sizes: number[]) => void>());

vi.mock("allotment", () => {
  function Allotment({
    children,
    vertical,
    onDragEnd,
    onDragStart,
    onChange,
    onReset,
    ref,
  }: {
    children: ReactNode;
    vertical?: boolean;
    onDragEnd?: (sizes: number[]) => void;
    onDragStart?: (sizes: number[]) => void;
    onChange?: (sizes: number[]) => void;
    onReset?: () => void;
    ref?: RefObject<{ resize: typeof resize } | null>;
  }) {
    const split = vertical ? "rows" : "columns";
    if (onDragEnd) dragEnds.set(split, onDragEnd);
    if (onDragStart) dragStarts.set(split, onDragStart);
    if (onChange) layouts.set(split, onChange);
    if (onReset) resets.set(split, onReset);
    if (ref) ref.current = { resize };
    return <div>{children}</div>;
  }
  Allotment.Pane = function Pane({
    children,
    preferredSize,
    snap,
  }: {
    children: ReactNode;
    preferredSize?: number;
    snap?: boolean;
  }) {
    return (
      <div data-size={preferredSize} data-snap={snap === true}>
        {children}
      </div>
    );
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

test("a drag that takes the panel under its snap point hides it, and one that takes it past again shows it, while a layout nobody dragged leaves visibility to the store", async () => {
  const workbench = await testWorkbench();
  render(<WorkbenchView workbench={workbench} />);
  const space = workbench.spaces.active?.id ?? "";
  const visible = () => workbench.spaces.state(space).parts.panel.visible;
  expect(
    [...document.querySelectorAll("[data-snap=true]")].map((pane) =>
      pane.getAttribute("data-size"),
    ),
  ).toEqual(["340"]);
  act(() => {
    workbench.spaces.setPart(space, "panel", { visible: true });
  });
  lay("rows", [840, 0]);
  expect(visible()).toBe(true);

  act(() => {
    dragStarts.get("rows")?.([500, 340]);
  });
  lay("rows", [760, 80]);
  expect(visible()).toBe(true);
  lay("rows", [840, 0]);
  expect(visible()).toBe(false);
  lay("rows", [700, 140]);
  expect(visible()).toBe(true);
  lay("rows", [840, 0]);
  expect(visible()).toBe(false);
  drag("rows", [840, 0]);

  act(() => {
    workbench.spaces.setPart(space, "panel", { visible: true });
  });
  lay("rows", [840, 0]);
  expect(visible()).toBe(true);
});

test("a hidden panel that is still maximized, dragged out by its sash, shows at the dragged height and not maximized, and a drag that ends while it is maximized remembers no height", async () => {
  const workbench = await testWorkbench();
  render(<WorkbenchView workbench={workbench} />);
  const space = workbench.spaces.active?.id ?? "";
  const panel = () => workbench.spaces.state(space).parts.panel;
  act(() => {
    workbench.spaces.setPart(space, "panel", {
      visible: false,
      maximized: true,
    });
  });
  act(() => {
    dragStarts.get("rows")?.([840, 0]);
  });
  lay("rows", [700, 140]);
  expect(panel()).toEqual({ visible: true, maximized: false });
  drag("rows", [700, 140]);
  expect(workbench.sizes.get("panel")).toBe(140);

  act(() => {
    workbench.spaces.setPart(space, "panel", {
      visible: true,
      maximized: true,
    });
  });
  drag("rows", [0, 840]);
  expect(workbench.sizes.get("panel")).toBe(140);
});

test("a double click on the sash gives the panel its default height, and that is the height it remembers", async () => {
  const workbench = await testWorkbench();
  render(<WorkbenchView workbench={workbench} />);
  drag("rows", [300, 540]);
  expect(workbench.sizes.get("panel")).toBe(540);
  act(() => {
    resets.get("rows")?.();
  });
  expect(resize).toHaveBeenCalledWith([0, 340]);
  expect(workbench.sizes.get("panel")).toBe(340);
});
