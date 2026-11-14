import { expect, test, vi } from "vitest";
import { testWorkbench } from "./testing";
import type { Workbench } from "./services";

const TENTHS = [1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2];

const press = (
  workbench: Workbench,
  code: string,
  init: KeyboardEventInit = {},
) =>
  workbench.keybindings.dispatch(
    new KeyboardEvent("keydown", {
      code,
      metaKey: true,
      cancelable: true,
      ...init,
    }),
  );

test("ten steps up from 1 land on 2 and ten down on 0.5, each a tenth, and neither limit is passed", async () => {
  const { zoom } = await testWorkbench();
  const up: number[] = [];
  for (let step = 0; step < 10; step++) {
    zoom.zoomIn();
    up.push(zoom.factor);
  }
  expect(up).toEqual(TENTHS);
  zoom.zoomIn();
  expect(zoom.factor).toBe(2);

  zoom.reset();
  const down: number[] = [];
  for (let step = 0; step < 5; step++) {
    zoom.zoomOut();
    down.push(zoom.factor);
  }
  expect(down).toEqual([0.9, 0.8, 0.7, 0.6, 0.5]);
  zoom.zoomOut();
  expect(zoom.factor).toBe(0.5);
});

test("a step that changes nothing announces nothing, and a reset from anywhere gives 1", async () => {
  const { zoom } = await testWorkbench();
  const heard = vi.fn();
  zoom.changes.subscribe(heard);
  zoom.reset();
  expect(heard).not.toHaveBeenCalled();
  zoom.zoomIn();
  zoom.zoomIn();
  expect(heard).toHaveBeenCalledTimes(2);
  zoom.reset();
  expect(zoom.factor).toBe(1);
  expect(heard).toHaveBeenCalledTimes(3);
});

test("the factor is the app's, kept in its state, and the next window starts on it", async () => {
  const workbench = await testWorkbench();
  workbench.zoom.zoomIn();
  workbench.zoom.zoomIn();
  workbench.zoom.zoomIn();
  await workbench.state.settled();
  const stored = await workbench.backend.invoke("state_load", null);
  expect(stored.app["window/zoom"]).toBe("1.3");
  expect(JSON.stringify(stored.spaces)).not.toContain("window/zoom");

  const next = await testWorkbench("ready", workbench.backend);
  expect(next.zoom.factor).toBe(1.3);
});

test.each(["0.2", "5", '"big"'])(
  "a stored %s is not a zoom, and the window starts at 1",
  async (value) => {
    const workbench = await testWorkbench();
    await workbench.backend.invoke("state_set", [
      { space: null, key: "window/zoom", value },
    ]);
    const next = await testWorkbench("ready", workbench.backend);
    expect(next.zoom.factor).toBe(1);
  },
);

test("⌘= and ⇧⌘= zoom in, ⌘- zooms out, ⌘0 resets, and the numpad's keys do the same", async () => {
  const workbench = await testWorkbench();
  const { zoom } = workbench;
  const steps: [string, KeyboardEventInit, number][] = [
    ["Equal", {}, 1.1],
    ["Equal", { shiftKey: true }, 1.2],
    ["NumpadAdd", {}, 1.3],
    ["Minus", {}, 1.2],
    ["NumpadSubtract", {}, 1.1],
    ["Numpad0", {}, 1],
    ["Equal", {}, 1.1],
    ["Digit0", {}, 1],
  ];
  for (const [code, init, factor] of steps) {
    expect(press(workbench, code, init), code).toBe(true);
    expect(zoom.factor, code).toBe(factor);
  }
});

test("Ctrl does it on Windows and Linux, and Cmd does not", async () => {
  const workbench = await testWorkbench("ready", undefined, "linux");
  expect(press(workbench, "Equal", { metaKey: false, ctrlKey: true })).toBe(
    true,
  );
  expect(workbench.zoom.factor).toBe(1.1);
  expect(press(workbench, "Equal")).toBe(false);
  expect(workbench.zoom.factor).toBe(1.1);
});
