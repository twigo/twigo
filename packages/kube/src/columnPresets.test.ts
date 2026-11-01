import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { IpcError } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { ColumnPresets } from "./columnPresets";
import { PODS } from "./kinds";

const KEY = "columns//pods";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function saved(value: string) {
  const backend = createMockBackend("ready");
  const stored = backend.invoke("state_set", { key: KEY, value });
  await vi.runAllTimersAsync();
  await stored;
  return backend;
}

async function read(backend: ReturnType<typeof createMockBackend>) {
  const value = backend.invoke("state_get", KEY);
  await vi.runAllTimersAsync();
  return value;
}

test("a choice made before the saved choices load joins them", async () => {
  const backend = await saved(JSON.stringify({ IP: true }));
  const presets = new ColumnPresets(backend, () => undefined);
  expect(presets.choices(PODS)).toEqual({});
  presets.choose(PODS, "Node", true);
  await vi.runAllTimersAsync();
  expect(presets.choices(PODS)).toEqual({ IP: true, Node: true });
  expect(JSON.parse((await read(backend)) ?? "")).toEqual({
    IP: true,
    Node: true,
  });
});

test("after a failed read, the next choice reads again before it saves", async () => {
  const backend = await saved(JSON.stringify({ IP: true }));
  const onError = vi.fn();
  vi.spyOn(backend, "invoke").mockRejectedValueOnce(
    new IpcError("internal", "disk"),
  );
  const presets = new ColumnPresets(backend, onError);
  presets.choices(PODS);
  await vi.runAllTimersAsync();
  expect(onError).toHaveBeenCalledTimes(1);
  expect(presets.choices(PODS)).toEqual({});
  presets.choose(PODS, "Node", true);
  await vi.runAllTimersAsync();
  expect(presets.choices(PODS)).toEqual({ IP: true, Node: true });
  expect(JSON.parse((await read(backend)) ?? "")).toEqual({
    IP: true,
    Node: true,
  });
});
