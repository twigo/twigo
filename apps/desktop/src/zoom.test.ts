import { afterEach, expect, test, vi } from "vitest";
import { testWorkbench } from "@twigo/workbench/testing";
import { installZoom } from "./zoom";

const host = vi.hoisted(() => ({
  app: false,
  setZoom: vi.fn<(factor: number) => Promise<void>>(),
}));

vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  isTauri: () => host.app,
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: host.setZoom }),
}));

afterEach(() => {
  host.app = false;
  host.setZoom.mockReset();
  document.documentElement.style.removeProperty("zoom");
});

async function startingAt(factor: number) {
  const first = await testWorkbench();
  await first.backend.invoke("state_set", [
    { space: null, key: "window/zoom", value: String(factor) },
  ]);
  return testWorkbench("ready", first.backend);
}

test("in the app the webview hears the starting factor once, then each change that moves it", async () => {
  host.app = true;
  host.setZoom.mockResolvedValue(undefined);
  const workbench = await startingAt(1.3);
  await installZoom(workbench);
  expect(host.setZoom.mock.calls).toEqual([[1.3]]);

  workbench.zoom.zoomIn();
  workbench.zoom.reset();
  await vi.waitFor(() => {
    expect(host.setZoom.mock.calls).toEqual([[1.3], [1.4], [1]]);
  });
  workbench.zoom.reset();
  await Promise.resolve();
  expect(host.setZoom).toHaveBeenCalledTimes(3);
  expect(document.documentElement.style.zoom).toBe("");
});

test("the webview hears one factor at a time, in the order they were chosen", async () => {
  host.app = true;
  const answers: (() => void)[] = [];
  host.setZoom.mockImplementation(
    () => new Promise<void>((resolve) => answers.push(resolve)),
  );
  const workbench = await startingAt(1);
  const started = installZoom(workbench);
  workbench.zoom.zoomIn();
  workbench.zoom.zoomIn();
  await Promise.resolve();
  expect(host.setZoom.mock.calls).toEqual([[1]]);

  answers[0]?.();
  await started;
  await vi.waitFor(() => {
    expect(host.setZoom.mock.calls).toEqual([[1], [1.1]]);
  });
  answers[1]?.();
  await vi.waitFor(() => {
    expect(host.setZoom.mock.calls).toEqual([[1], [1.1], [1.2]]);
  });
});

test("a refused zoom is reported, and the next change is still applied", async () => {
  host.app = true;
  host.setZoom.mockRejectedValueOnce(new Error("not allowed"));
  host.setZoom.mockResolvedValue(undefined);
  const workbench = await startingAt(1);
  const report = vi
    .spyOn(workbench, "report")
    .mockImplementation(() => undefined);
  await installZoom(workbench);
  expect(report).toHaveBeenCalledExactlyOnceWith(new Error("not allowed"));

  workbench.zoom.zoomIn();
  await vi.waitFor(() => {
    expect(host.setZoom).toHaveBeenLastCalledWith(1.1);
  });
});

test("in the browser the page's CSS zoom has the starting factor before anything renders, and follows each change", async () => {
  const workbench = await startingAt(0.8);
  await installZoom(workbench);
  expect(document.documentElement.style.zoom).toBe("0.8");
  expect(host.setZoom).not.toHaveBeenCalled();

  workbench.zoom.zoomIn();
  await vi.waitFor(() => {
    expect(document.documentElement.style.zoom).toBe("0.9");
  });
});
