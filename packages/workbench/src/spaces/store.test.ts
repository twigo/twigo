import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Backend, Context } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { ContextKeys } from "../contextkey/service";
import { StateStore } from "../state/store";
import { Catalog } from "./catalog";
import { DEFAULT_STATE, Spaces } from "./store";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function settled<T>(pending: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return pending;
}

async function window(backend: Backend = createMockBackend("ready")) {
  const keys = new ContextKeys();
  const onError = vi.fn();
  const state = await settled(StateStore.load(backend, onError));
  const catalog = new Catalog(backend);
  const spaces = new Spaces(backend, state, catalog, keys, onError);
  await settled(Promise.all([catalog.watch(), spaces.load()]));
  return { spaces, state, keys, backend, onError };
}

test("loading selects the first space and sets its context keys", async () => {
  const { spaces, keys } = await window();
  expect(spaces.active?.id).toBe("prod-eu");
  const lookup = keys.lookup(null);
  expect(lookup("context.name")).toBe("prod-eu");
  expect(lookup("space.count")).toBe(3);
  expect(lookup("space.multiContext")).toBe(false);
});

test("the next window comes back to the space, its parts, namespaces and views", async () => {
  const backend = createMockBackend("ready");
  const first = await window(backend);
  first.spaces.select("staging");
  first.spaces.setPart("staging", "panel", { visible: true, container: "out" });
  first.spaces.update("staging", (state) => ({
    ...state,
    namespaces: ["payments"],
  }));
  first.spaces.setView("staging", "tree", { open: ["Config"] });
  await settled(first.state.settled());

  const { spaces } = await window(backend);
  expect(spaces.active?.id).toBe("staging");
  expect(spaces.state("staging").parts.panel).toEqual({
    visible: true,
    container: "out",
  });
  expect(spaces.state("staging").namespaces).toEqual(["payments"]);
  expect(spaces.view("staging", "tree")).toEqual({ open: ["Config"] });
  expect(spaces.view("prod-eu", "tree")).toBeUndefined();
});

test("a change goes to the backend at once, one key per part of the state", async () => {
  const { spaces, backend } = await window();
  const invoke = vi.spyOn(backend, "invoke");
  spaces.setPart("prod-eu", "panel", { visible: true });
  spaces.update("prod-eu", (state) => ({ ...state, namespaces: ["a"] }));
  await Promise.resolve();
  expect(invoke).toHaveBeenCalledExactlyOnceWith("state_set", [
    {
      space: "prod-eu",
      key: "parts",
      value: JSON.stringify({
        ...DEFAULT_STATE.parts,
        panel: { visible: true },
      }),
    },
    { space: "prod-eu", key: "namespaces", value: '["a"]' },
  ]);
});

test("an update that changes nothing neither notifies nor saves", async () => {
  const { spaces, backend } = await window();
  const invoke = vi.spyOn(backend, "invoke");
  const listener = vi.fn();
  spaces.changes.subscribe(listener);
  spaces.setPart("prod-eu", "sidebar", { visible: true });
  await vi.runAllTimersAsync();
  expect(listener).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
});

test("what a key holds reads back as far as it fits", async () => {
  const backend = createMockBackend("ready");
  await settled(
    backend.invoke("state_set", [
      {
        space: "prod-eu",
        key: "parts",
        value: '{"panel":{"visible":"yes","container":"out"},"secondary":3}',
      },
      { space: "prod-eu", key: "namespaces", value: '["a",1]' },
      { space: "prod-eu", key: "placement", value: '{"view":"there"}' },
      { space: "prod-eu", key: "editors", value: "[]" },
    ]),
  );
  const { spaces } = await window(backend);
  expect(spaces.state("prod-eu")).toEqual({
    ...DEFAULT_STATE,
    parts: {
      ...DEFAULT_STATE.parts,
      panel: { visible: false, container: "out" },
    },
    placement: { view: "there" },
  });
});

test("opening a context without a space adds its space and selects it", async () => {
  const { spaces } = await window();
  await settled(spaces.open("kind-local"));
  expect(spaces.list.map((space) => space.id)).toContain("kind-local");
  expect(spaces.active?.id).toBe("kind-local");
});

test("opening the same context twice at once adds its space once", async () => {
  const { spaces } = await window();
  await settled(
    Promise.all([spaces.open("kind-local"), spaces.open("kind-local")]),
  );
  expect(spaces.list.filter((space) => space.id === "kind-local")).toHaveLength(
    1,
  );
  expect(spaces.active?.id).toBe("kind-local");
});

test("a failed save reaches onError", async () => {
  const { spaces, backend, onError } = await window();
  vi.spyOn(backend, "invoke").mockRejectedValue(new Error("disk full"));
  spaces.setPart("prod-eu", "panel", { visible: true });
  await vi.runAllTimersAsync();
  expect(onError).toHaveBeenCalledWith(new Error("disk full"));
});

function withCatalog(contexts: readonly Context[]) {
  const backend = createMockBackend("ready");
  let send: ((next: Context[]) => void) | undefined;
  const subscribe = backend.subscribe.bind(backend);
  vi.spyOn(backend, "subscribe").mockImplementation((command, request, on) => {
    if (command !== "contexts_watch") return subscribe(command, request, on);
    send = on;
    return Promise.resolve([...contexts]);
  });
  const change = (next: readonly Context[]) => {
    send?.([...next]);
  };
  return { backend, change };
}

test("the rail hides a space whose context no source lists, and shows it again when it comes back", async () => {
  const all = [
    { name: "prod-eu", color: null },
    { name: "staging", color: null },
    { name: "dev", color: null },
  ];
  const { backend, change } = withCatalog(all);
  const { spaces, keys } = await window(backend);
  expect(spaces.active?.id).toBe("prod-eu");

  change(all.slice(1));
  expect(spaces.list.map((space) => space.id)).toEqual(["staging", "dev"]);
  expect(spaces.active?.id).toBe("staging");
  expect(keys.lookup(null)("space.count")).toBe(2);

  change(all);
  expect(spaces.list.map((space) => space.id)).toEqual([
    "prod-eu",
    "staging",
    "dev",
  ]);
});

test("with no space for any listed context, the first context's space opens", async () => {
  const { backend } = withCatalog([{ name: "kind-local", color: null }]);
  const { spaces } = await window(backend);
  await vi.runAllTimersAsync();
  expect(spaces.list.map((space) => space.id)).toEqual(["kind-local"]);
  expect(spaces.active?.id).toBe("kind-local");
});
