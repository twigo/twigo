import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMockBackend } from "@twigo/protocol/mock";
import { ContextKeys } from "../contextkey/service";
import { DEFAULT_STATE, readState, Spaces } from "./store";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function loaded(backend = createMockBackend("ready")) {
  const keys = new ContextKeys();
  const onError = vi.fn();
  const spaces = new Spaces(backend, keys, onError);
  const done = spaces.load();
  await vi.runAllTimersAsync();
  await done;
  return { spaces, keys, backend, onError };
}

test("loading selects the first space and sets its context keys", async () => {
  const { spaces, keys } = await loaded();
  expect(spaces.active?.id).toBe("prod-eu");
  const lookup = keys.lookup(null);
  expect(lookup("context.name")).toBe("prod-eu");
  expect(lookup("space.count")).toBe(4);
  expect(lookup("space.multiContext")).toBe(false);
});

test("a change is saved once, debounced, and read back by the next window", async () => {
  const backend = createMockBackend("ready");
  const { spaces } = await loaded(backend);
  const save = vi.spyOn(backend, "invoke");
  spaces.setPart("prod-eu", "panel", { visible: true });
  spaces.setPart("prod-eu", "panel", { size: 180 });
  expect(save).not.toHaveBeenCalledWith("state_set", expect.anything());
  await vi.advanceTimersByTimeAsync(400);
  expect(
    save.mock.calls.filter(([command]) => command === "state_set"),
  ).toHaveLength(1);
  const { spaces: next } = await loaded(backend);
  expect(next.state("prod-eu").parts.panel).toEqual({
    visible: true,
    size: 180,
    container: undefined,
  });
});

test("an update that changes nothing neither notifies nor saves", async () => {
  const { spaces, backend } = await loaded();
  const save = vi.spyOn(backend, "invoke");
  const listener = vi.fn();
  spaces.changes.subscribe(listener);
  spaces.setPart("prod-eu", "sidebar", { visible: true });
  await vi.advanceTimersByTimeAsync(400);
  expect(listener).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});

test("opening a context without a space adds its space and selects it", async () => {
  const { spaces } = await loaded();
  const done = spaces.open("kind-local");
  await vi.runAllTimersAsync();
  await done;
  expect(spaces.list.map((space) => space.id)).toContain("kind-local");
  expect(spaces.active?.id).toBe("kind-local");
});

test("a failed save reaches onError", async () => {
  const { spaces, backend, onError } = await loaded();
  vi.spyOn(backend, "invoke").mockRejectedValue(new Error("disk full"));
  spaces.setPart("prod-eu", "panel", { visible: true });
  await vi.advanceTimersByTimeAsync(400);
  expect(onError).toHaveBeenCalledWith(new Error("disk full"));
});

test.each([
  ["not json", DEFAULT_STATE],
  ["[]", DEFAULT_STATE],
  [
    '{"parts":{"panel":{"visible":"yes","size":-3}},"namespaces":["a",1]}',
    {
      ...DEFAULT_STATE,
      namespaces: ["a"],
    },
  ],
  [
    '{"placement":{"view":"container","bad":2}}',
    {
      ...DEFAULT_STATE,
      placement: { view: "container" },
    },
  ],
])("a saved state %s reads back as far as it fits", (json, expected) => {
  expect(readState(json)).toEqual(expected);
});
