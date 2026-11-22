import { UNMARKED } from "@twigo/protocol/mock";
import { expect, test, vi } from "vitest";
import type {
  Backend,
  Catalog as Listed,
  CatalogFailure,
  Context,
} from "@twigo/protocol";
import { Catalog } from "./catalog";

const ONE: Context[] = [
  {
    name: "kind-one",
    color: null,
    source: "~/.kube/config",
    server: null,
    namespace: null,
    access: UNMARKED,
    problem: null,
  },
];
const TWO: Context[] = [
  {
    name: "kind-two",
    color: "green",
    source: "~/.kube/config",
    server: null,
    namespace: null,
    access: UNMARKED,
    problem: null,
  },
];

function backend(early: Context[] | undefined) {
  let send: ((next: Listed) => void) | undefined;
  const fake = {
    invoke: vi.fn(),
    subscribe: vi.fn((_command: string, _request: unknown, on: typeof send) => {
      send = on;
      if (early) on?.({ contexts: early, failures: [] });
      return Promise.resolve({ contexts: ONE, failures: [] });
    }),
  } as unknown as Backend;
  return {
    fake,
    send: (next: Context[]) => send?.({ contexts: next, failures: [] }),
  };
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

const failing = (source: string): CatalogFailure => ({
  source,
  error: {
    code: "kubeconfig.unparsable",
    kind: "invalidInput",
    message: "Cannot be parsed: unclosed bracket '[' at line 7, column 10",
  },
});

test("a file that fails is announced once, again only after it has been read well in between", async () => {
  let send: ((next: Listed) => void) | undefined;
  const fake = {
    invoke: vi.fn(),
    subscribe: vi.fn((_command: string, _request: unknown, on: typeof send) => {
      send = on;
      return Promise.resolve({
        contexts: ONE,
        failures: [failing("~/.kube/a.yaml")],
      });
    }),
  } as unknown as Backend;
  const announce = vi.fn();
  const catalog = new Catalog(fake, announce);
  await catalog.watch();
  expect(catalog.failures.map(({ source }) => source)).toEqual([
    "~/.kube/a.yaml",
  ]);
  expect(announce).toHaveBeenCalledTimes(1);

  send?.({ contexts: TWO, failures: [failing("~/.kube/a.yaml")] });
  expect(announce).toHaveBeenCalledTimes(1);

  send?.({
    contexts: TWO,
    failures: [failing("~/.kube/a.yaml"), failing("~/.kube/b.yaml")],
  });
  expect(announce).toHaveBeenCalledTimes(2);
  expect(announce).toHaveBeenLastCalledWith(failing("~/.kube/b.yaml"));

  send?.({ contexts: TWO, failures: [] });
  send?.({ contexts: TWO, failures: [failing("~/.kube/a.yaml")] });
  expect(announce).toHaveBeenCalledTimes(3);
});
