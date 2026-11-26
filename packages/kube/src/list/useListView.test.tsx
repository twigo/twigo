import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  type Backend,
  type ListBatch,
  type ListQuery,
  type RequestOf,
} from "@twigo/protocol";
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

function batch(metrics: ListBatch["metrics"], view = 0, seq = 1): ListBatch {
  return {
    seq,
    view,
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
  const invoked: [string, unknown][] = [];
  const opened: ((id: number) => void)[] = [];
  const backend: Backend = {
    invoke: (command, request) => {
      invoked.push([command, request]);
      return Promise.resolve(null as never);
    },
    subscribe: (_command, _request, onMessage) => {
      sends.push(onMessage);
      return deferred
        ? new Promise((resolve) => opened.push(resolve))
        : Promise.resolve(sends.length as never);
    },
  };
  let deferred = false;
  return {
    backend,
    views: () =>
      invoked.flatMap(([command, request]) =>
        command === "list_set_view"
          ? [request as RequestOf<"list_set_view">]
          : [],
      ),
    subscriptions: () => sends.length,
    defer: () => {
      deferred = true;
    },
    open: (id: number) => {
      opened.shift()?.(id);
    },
    send: (at: number, next: ListBatch) => {
      act(() => {
        sends[at]?.(next);
      });
    },
  };
}

async function shown(first: ListQuery) {
  const list = fake();
  const view = renderHook(({ query }) => useListView(list.backend, query), {
    initialProps: { query: first },
  });
  await act(() => vi.advanceTimersByTimeAsync(10));
  return {
    ...list,
    metrics: () => view.result.current.snapshot.metrics,
    shown: () => view.result.current.query,
    ask: async (query: ListQuery) => {
      view.rerender({ query });
      await act(() => vi.advanceTimersByTimeAsync(10));
    },
  };
}

test("a new subscription of the same list starts with the state the one it replaces last said, and the state of its own replaces it", async () => {
  const list = await shown(PODS);
  list.send(0, batch("forbidden"));
  expect(list.metrics()).toBe("forbidden");
  await list.ask({ ...PODS, namespaces: ["payments"] });
  list.send(1, batch(null));
  expect(list.metrics()).toBe("forbidden");
  await list.ask({ ...PODS, namespaces: ["auth"] });
  list.send(2, batch("ready"));
  expect(list.metrics()).toBe("ready");
});

test("a change of the view part is sent to the subscription the list has, and its query comes with the first batch that names it", async () => {
  const list = await shown(PODS);
  list.send(0, batch("forbidden"));
  expect(list.shown()).toEqual(PODS);
  await list.ask({ ...PODS, text: "payments" });
  expect(list.subscriptions()).toBe(1);
  expect(list.views()).toEqual([
    {
      id: 1,
      view: 1,
      text: "payments",
      columns: null,
      sort: null,
      countBy: null,
      groupBy: null,
      values: null,
    },
  ]);
  list.send(0, batch(null, 0, 2));
  expect(list.shown(), "the rows on screen answer the old query").toEqual(PODS);
  list.send(0, batch(null, 1, 3));
  expect(list.shown()).toEqual({ ...PODS, text: "payments" });
  expect(list.metrics(), "its state stays").toBe("forbidden");
});

test("changes of the view before the subscription has its id go out once, as the last", async () => {
  const list = fake();
  list.defer();
  const view = renderHook(({ query }) => useListView(list.backend, query), {
    initialProps: { query: PODS },
  });
  view.rerender({ query: { ...PODS, text: "a" } });
  view.rerender({ query: { ...PODS, text: "ab" } });
  await act(() => vi.advanceTimersByTimeAsync(10));
  expect(list.views()).toEqual([]);
  list.open(7);
  await act(() => vi.advanceTimersByTimeAsync(10));
  expect(list.views()).toMatchObject([{ id: 7, view: 2, text: "ab" }]);
  list.send(0, batch(null, 2));
  expect(view.result.current.query).toEqual({ ...PODS, text: "ab" });
});

test("a change of the namespaces and of the view together is one new subscription", async () => {
  const list = await shown(PODS);
  await list.ask({ ...PODS, namespaces: ["auth"], text: "web" });
  expect(list.subscriptions()).toBe(2);
  expect(list.views()).toEqual([]);
  list.send(1, batch(null));
  expect(list.shown()).toEqual({ ...PODS, namespaces: ["auth"], text: "web" });
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
