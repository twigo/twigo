import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Backend } from "./backend";
import { IpcError } from "./error";
import type { ListBatch, ListQuery, Row } from "./generated";
import { ListView } from "./list";

const QUERY: ListQuery = {
  space: "s",
  gvr: { group: "", version: "v1", resource: "pods" },
  namespaced: true,
  namespaces: [],
  labelSelector: null,
  text: null,
  columns: null,
  sort: null,
  groupBy: null,
  values: null,
};

function row(id: string, ...cells: Row["cells"]): Row {
  return { id, created: null, cells };
}

function batch(seq: number, rest: Partial<ListBatch> = {}): ListBatch {
  return {
    seq,
    total: 2,
    columns: null,
    window: null,
    upserts: [],
    status: { state: "ready" },
    groups: null,
    ...rest,
  };
}

function fakeBackend() {
  let send: ((batch: ListBatch) => void) | undefined;
  let resolve: ((id: number) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  const calls: [string, unknown][] = [];
  const backend: Backend = {
    invoke(command, request) {
      calls.push([command, request]);
      return Promise.resolve(null);
    },
    subscribe(_command, _request, onMessage) {
      send = onMessage;
      return new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
    },
  };
  return {
    backend,
    calls,
    send: (b: ListBatch) => send?.(b),
    resolve: (id: number) => resolve?.(id),
    reject: (error: unknown) => reject?.(error),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("a batch replaces the window and reports the cells it changed", async () => {
  const fake = fakeBackend();
  const view = new ListView(fake.backend, QUERY);
  fake.resolve(7);
  await vi.runAllTimersAsync();

  fake.send(
    batch(1, {
      columns: [{ name: "Name", kind: "string", priority: 0 }],
      window: { start: 4, ids: ["a", "b"] },
      upserts: [row("a", "a", 1), row("b", "b", 1)],
    }),
  );
  fake.send(batch(2, { upserts: [row("b", "b", 2)] }));

  const snapshot = view.getSnapshot();
  expect(snapshot.start).toBe(4);
  expect(snapshot.ids).toEqual(["a", "b"]);
  expect(snapshot.columns.map((c) => c.name)).toEqual(["Name"]);
  expect(snapshot.rows.get("b")?.cells).toEqual(["b", 2]);
  expect([...snapshot.changed]).toEqual([["b", [1]]]);

  fake.send(batch(3, { window: { start: 5, ids: ["b"] } }));
  expect([...view.getSnapshot().rows.keys()]).toEqual(["b"]);
  expect(view.getSnapshot().changed.size).toBe(0);
});

test("a batch without groups keeps the previous ones", async () => {
  const fake = fakeBackend();
  const view = new ListView(fake.backend, QUERY);
  fake.resolve(7);
  await vi.runAllTimersAsync();
  const groups = [{ value: "Running", count: 2 }];
  fake.send(batch(1, { window: { start: 0, ids: [] }, groups }));
  fake.send(batch(2, { total: 3 }));
  expect(view.getSnapshot().total).toBe(3);
  expect(view.getSnapshot().groups).toEqual(groups);
});

test("every seq is acknowledged once, after the next frame", async () => {
  const fake = fakeBackend();
  new ListView(fake.backend, QUERY);
  fake.resolve(7);
  await vi.runAllTimersAsync();

  fake.send(batch(1, { window: { start: 0, ids: [] } }));
  expect(fake.calls).toEqual([]);
  vi.advanceTimersToNextFrame();
  expect(fake.calls).toEqual([["list_ack", { id: 7, seq: 1 }]]);
});

test("a batch that arrives before the subscription id is acknowledged once the id is known", async () => {
  const fake = fakeBackend();
  const view = new ListView(fake.backend, QUERY);
  view.setWindow(0, 40);
  fake.send(batch(1, { window: { start: 0, ids: [] } }));
  vi.advanceTimersToNextFrame();
  expect(fake.calls).toEqual([]);

  fake.resolve(7);
  await vi.runAllTimersAsync();
  expect(fake.calls).toEqual([
    ["list_set_window", { id: 7, start: 0, end: 40 }],
    ["list_ack", { id: 7, seq: 1 }],
  ]);
});

test("a failed subscribe shows the error state", async () => {
  const fake = fakeBackend();
  const view = new ListView(fake.backend, QUERY);
  fake.reject({ kind: "forbidden", message: "no" });
  await vi.runAllTimersAsync();
  const status = view.getSnapshot().status;
  expect(status.state).toBe("error");
  expect(status.state === "error" && status.error).toBeInstanceOf(IpcError);
});

test("close unsubscribes and ignores later batches", async () => {
  const fake = fakeBackend();
  const view = new ListView(fake.backend, QUERY);
  fake.resolve(7);
  await vi.runAllTimersAsync();
  view.close();
  fake.send(batch(1, { total: 99 }));
  expect(view.getSnapshot().total).toBe(0);
  expect(fake.calls).toEqual([["list_unsubscribe", 7]]);
});
