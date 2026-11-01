import * as v from "valibot";
import { expect, test, vi } from "vitest";
import type { Backend, StateEntry } from "@twigo/protocol";
import { StateStore } from "./store";

function slowBackend() {
  const sets: StateEntry[][] = [];
  const answers: (() => void)[] = [];
  const backend = {
    invoke: vi.fn((command: string, request: unknown) => {
      if (command === "state_load") {
        return Promise.resolve({
          app: { kept: '"text"', count: '"not a number"' },
          spaces: { "prod-eu": { namespaces: '["default"]' } },
        });
      }
      sets.push(request as StateEntry[]);
      return new Promise<null>((resolve) => answers.push(() => resolve(null)));
    }),
    subscribe: vi.fn(),
  } as unknown as Backend;
  const answer = async () => {
    answers.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { backend, sets, answer };
}

test("reads what was stored, and the fallback where nothing fits", async () => {
  const { backend } = slowBackend();
  const state = await StateStore.load(backend, vi.fn());
  expect(state.get(null, "kept", v.string(), "none")).toBe("text");
  expect(state.get(null, "count", v.number(), 0)).toBe(0);
  expect(state.get(null, "absent", v.number(), 7)).toBe(7);
  expect(state.get("prod-eu", "namespaces", v.array(v.string()), [])).toEqual([
    "default",
  ]);
  expect(state.get("staging", "namespaces", v.array(v.string()), [])).toEqual(
    [],
  );
});

test("changes in one task go as one set; one set at a time; the latest value wins", async () => {
  const { backend, sets, answer } = slowBackend();
  const state = await StateStore.load(backend, vi.fn());
  state.set(null, "a", 1);
  state.set("prod-eu", "b", [1]);
  state.set(null, "kept", "text");
  expect(sets).toHaveLength(0);
  await Promise.resolve();
  expect(sets).toEqual([
    [
      { space: null, key: "a", value: "1" },
      { space: "prod-eu", key: "b", value: "[1]" },
    ],
  ]);

  state.set(null, "a", 2);
  state.set(null, "a", 3);
  await Promise.resolve();
  expect(sets).toHaveLength(1);
  await answer();
  expect(sets[1]).toEqual([{ space: null, key: "a", value: "3" }]);
  expect(state.get(null, "a", v.number(), 0)).toBe(3);

  const settled = state.settled();
  await answer();
  await settled;
  expect(sets).toHaveLength(2);
});

test("a failed set reaches onError, and the next change still goes", async () => {
  const onError = vi.fn();
  const sets: unknown[] = [];
  const backend = {
    invoke: vi.fn((command: string, request: unknown) => {
      if (command === "state_load")
        return Promise.resolve({ app: {}, spaces: {} });
      sets.push(request);
      return sets.length === 1
        ? Promise.reject(new Error("disk full"))
        : Promise.resolve(null);
    }),
    subscribe: vi.fn(),
  } as unknown as Backend;
  const state = await StateStore.load(backend, onError);
  state.set(null, "a", 1);
  await state.settled();
  expect(onError).toHaveBeenCalledWith(new Error("disk full"));
  state.set(null, "a", 2);
  await state.settled();
  expect(sets).toHaveLength(2);
});
