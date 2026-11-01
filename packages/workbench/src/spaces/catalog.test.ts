import { expect, test, vi } from "vitest";
import type { Backend, Context } from "@twigo/protocol";
import { Catalog } from "./catalog";

const ONE: Context[] = [{ name: "kind-one", color: null }];
const TWO: Context[] = [{ name: "kind-two", color: "green" }];

function backend(early: Context[] | undefined) {
  let send: ((next: Context[]) => void) | undefined;
  const fake = {
    invoke: vi.fn(),
    subscribe: vi.fn((_command: string, _request: unknown, on: typeof send) => {
      send = on;
      if (early) on?.(early);
      return Promise.resolve(ONE);
    }),
  } as unknown as Backend;
  return { fake, send: (next: Context[]) => send?.(next) };
}

test("lists the answer, then each change", async () => {
  const { fake, send } = backend(undefined);
  const catalog = new Catalog(fake);
  expect(catalog.list).toBeUndefined();
  await catalog.watch();
  expect(catalog.list).toEqual(ONE);
  const listener = vi.fn();
  catalog.changes.subscribe(listener);
  send(TWO);
  expect(catalog.find("kind-two")?.color).toBe("green");
  expect(listener).toHaveBeenCalledOnce();
});

test("a change that arrives before the answer is the newer list", async () => {
  const { fake } = backend(TWO);
  const catalog = new Catalog(fake);
  await catalog.watch();
  expect(catalog.list).toEqual(TWO);
});
