import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Backend, ListBatch, ListQuery } from "@twigo/protocol";
import { useListView } from "./useListView";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const PODS: ListQuery = {
  space: "prod-eu",
  gvr: { group: "", version: "v1", resource: "pods" },
  namespaced: true,
  namespaces: [],
  labelSelector: null,
  fieldSelector: null,
  owners: null,
  text: null,
  columns: null,
  sort: null,
  countBy: null,
  groupBy: null,
  values: null,
};

function batch(metrics: ListBatch["metrics"]): ListBatch {
  return {
    seq: 1,
    total: 0,
    columns: [{ name: "Name", kind: "string", priority: 0 }],
    window: { start: 0, ids: [] },
    upserts: [],
    status: { state: "ready" },
    counts: null,
    groups: null,
    metrics,
  };
}

function fake() {
  const sends: ((batch: ListBatch) => void)[] = [];
  const backend: Backend = {
    invoke: () => Promise.resolve(null as never),
    subscribe: (_command, _request, onMessage) => {
      sends.push(onMessage);
      return Promise.resolve(sends.length as never);
    },
  };
  return {
    backend,
    send: (at: number, next: ListBatch) => {
      act(() => {
        sends[at]?.(next);
      });
    },
  };
}

async function shown(first: ListQuery) {
  const { backend, send } = fake();
  const view = renderHook(({ query }) => useListView(backend, query), {
    initialProps: { query: first },
  });
  await act(() => vi.advanceTimersByTimeAsync(10));
  return {
    send,
    metrics: () => view.result.current.snapshot.metrics,
    ask: async (query: ListQuery) => {
      view.rerender({ query });
      await act(() => vi.advanceTimersByTimeAsync(10));
    },
  };
}

test("a new query of the same list starts with the state the view it replaces last said, and the state of its own replaces it", async () => {
  const list = await shown(PODS);
  list.send(0, batch("forbidden"));
  expect(list.metrics()).toBe("forbidden");
  await list.ask({ ...PODS, text: "payments" });
  list.send(1, batch(null));
  expect(list.metrics()).toBe("forbidden");
  await list.ask({ ...PODS, text: "auth" });
  list.send(2, batch("ready"));
  expect(list.metrics()).toBe("ready");
});

test.each([
  ["resource", { ...PODS, gvr: { ...PODS.gvr, resource: "nodes" } }],
  ["space", { ...PODS, space: "staging" }],
])("a list of another %s starts with none", async (_, other) => {
  const list = await shown(PODS);
  list.send(0, batch("forbidden"));
  await list.ask(other);
  list.send(1, batch(null));
  expect(list.metrics()).toBeNull();
});
