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
  fieldSelector: null,
  owners: null,
  text: null,
  columns: null,
  sort: null,
  countBy: null,
  groupBy: null,
  values: null,
};

function row(id: string, ...cells: Row["cells"]): Row {
  return { id, created: null, generated: null, cells };
}

function batch(seq: number, rest: Partial<ListBatch> = {}): ListBatch {
  return {
    seq,
    total: 2,
    columns: null,
    window: null,
    upserts: [],
    status: { state: "ready" },
    counts: null,
    groups: null,
    metrics: null,
    ...rest,
  };
}

function fakeBackend() {
  let send: ((batch: ListBatch) => void) | undefined;
  let resolve: ((id: number) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  const calls: [string, unknown][] = [];
  const opened = { count: 0 };
  const backend: Backend = {
    invoke(command, request) {
      calls.push([command, request]);
      return Promise.resolve(null);
    },
    subscribe(_command, _request, onMessage) {
      opened.count++;
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
    get subscribes() {
      return opened.count;
    },
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

test("a batch without counts keeps the previous ones", async () => {
  const fake = fakeBackend();
  const view = new ListView(fake.backend, QUERY);
  fake.resolve(7);
  await vi.runAllTimersAsync();
  const counts = [{ value: "Running", count: 2 }];
  fake.send(batch(1, { window: { start: 0, ids: [] }, counts }));
  fake.send(batch(2, { total: 3 }));
  expect(view.getSnapshot().total).toBe(3);
  expect(view.getSnapshot().counts).toEqual(counts);
});

test("a batch without groups keeps the previous ones", async () => {
  const fake = fakeBackend();
  const view = new ListView(fake.backend, QUERY);
  fake.resolve(7);
  await vi.runAllTimersAsync();
  const groups = [{ value: "alpha", rows: 2, counts: [] }];
  fake.send(batch(1, { window: { start: 0, ids: [] }, groups }));
  fake.send(batch(2, { total: 3 }));
  expect(view.getSnapshot().groups).toEqual(groups);
  fake.send(batch(3, { groups: [] }));
  expect(view.getSnapshot().groups).toEqual([]);
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
    ["list_set_window", { id: 7, start: 0, end: 40, metrics: false }],
    ["list_ack", { id: 7, seq: 1 }],
  ]);
});

test("a window says whether the list reads its metrics, and a change of that alone sends the window again", async () => {
  const fake = fakeBackend();
  const view = new ListView(fake.backend, QUERY);
  view.setMetrics(true);
  view.setWindow(0, 40);
  fake.resolve(7);
  await vi.runAllTimersAsync();
  view.setMetrics(true);
  view.setMetrics(false);
  view.setWindow(0, 40);
  view.setWindow(10, 50);
  expect(fake.calls).toEqual([
    ["list_set_window", { id: 7, start: 0, end: 40, metrics: true }],
    ["list_set_window", { id: 7, start: 0, end: 40, metrics: false }],
    ["list_set_window", { id: 7, start: 10, end: 50, metrics: false }],
  ]);
  expect(fake.subscribes).toBe(1);
});

test("metrics asked for before any window wait for it", async () => {
  const fake = fakeBackend();
  const view = new ListView(fake.backend, QUERY);
  fake.resolve(7);
  await vi.runAllTimersAsync();
  view.setMetrics(true);
  expect(fake.calls).toEqual([]);
  view.setWindow(0, 40);
  expect(fake.calls).toEqual([
    ["list_set_window", { id: 7, start: 0, end: 40, metrics: true }],
  ]);
});

test("a batch's metrics state stays until another comes", async () => {
  const fake = fakeBackend();
  const view = new ListView(fake.backend, QUERY);
  fake.resolve(7);
  await vi.runAllTimersAsync();
  expect(view.getSnapshot().metrics).toBeNull();
  fake.send(batch(1, { metrics: "ready" }));
  fake.send(batch(2, { total: 3 }));
  expect(view.getSnapshot().metrics).toBe("ready");
  fake.send(batch(3, { metrics: "unavailable" }));
  expect(view.getSnapshot().metrics).toBe("unavailable");
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
