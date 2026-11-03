import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Backend } from "./backend";
import type { LogBatch, LogSource, LogView, OpenLogs } from "./generated";
import { LogsSession } from "./logs";

const SOURCE: LogSource = {
  containers: { type: "default" },
  pods: null,
  since: { type: "seconds", seconds: 900 },
  previous: false,
};

const VIEW: LogView = { level: "all", filter: null, search: null, range: null };

const OPEN: OpenLogs = {
  target: {
    space: "s",
    gvr: { group: "apps", version: "v1", resource: "deployments" },
    namespace: "payments",
    name: "api",
  },
  source: SOURCE,
  view: VIEW,
};

function batch(seq: number, rest: Partial<LogBatch> = {}): LogBatch {
  return {
    seq,
    status: { state: "ready" },
    pods: null,
    total: 0,
    window: null,
    matches: null,
    histogram: null,
    dropped: 0,
    ...rest,
  };
}

function fakeBackend() {
  let send: ((batch: LogBatch) => void) | undefined;
  let resolve: ((id: number) => void) | undefined;
  const calls: [string, unknown][] = [];
  const backend: Backend = {
    invoke(command, request) {
      calls.push([command, request]);
      return Promise.resolve(null);
    },
    subscribe(_command, request, onMessage) {
      calls.push(["logs_open", request]);
      send = onMessage;
      return new Promise((res) => {
        resolve = res;
      });
    },
  };
  return {
    backend,
    calls,
    send: (b: LogBatch) => send?.(b),
    resolve: (id: number) => resolve?.(id),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("what changes before the id arrives goes once it does, and only what changed", async () => {
  const fake = fakeBackend();
  const session = new LogsSession(fake.backend, OPEN);
  const view = { ...VIEW, search: "refused" };
  session.setView(view);
  session.setWindow({ type: "tail", count: 60 });
  expect(fake.calls.map(([command]) => command)).toEqual(["logs_open"]);
  fake.resolve(4);
  await vi.runAllTimersAsync();
  expect(fake.calls.slice(1)).toEqual([
    ["logs_set_view", { id: 4, view }],
    ["logs_set_window", { id: 4, window: { type: "tail", count: 60 } }],
  ]);
  session.setWindow({ type: "tail", count: 60 });
  session.setSource({ ...SOURCE, previous: true });
  expect(fake.calls.slice(3)).toEqual([
    ["logs_set_source", { id: 4, source: { ...SOURCE, previous: true } }],
  ]);
});

test("a batch keeps what it does not carry and is acked on the next frame", async () => {
  const fake = fakeBackend();
  const session = new LogsSession(fake.backend, OPEN);
  fake.resolve(2);
  await vi.runAllTimersAsync();
  const pods = [
    {
      name: "api-1",
      generated: null,
      status: "Running",
      tone: "neutral" as const,
      containers: [],
    },
  ];
  fake.send(batch(1, { pods, total: 3 }));
  fake.send(batch(2, { total: 4, dropped: 1 }));
  expect(session.getSnapshot()).toMatchObject({
    seq: 2,
    pods,
    total: 4,
    dropped: 1,
  });
  await vi.runAllTimersAsync();
  expect(fake.calls).toContainEqual(["logs_ack", { id: 2, seq: 2 }]);
});

test("a session closed before its id arrives closes once it does", async () => {
  const fake = fakeBackend();
  const session = new LogsSession(fake.backend, OPEN);
  session.close();
  fake.resolve(9);
  await vi.runAllTimersAsync();
  expect(fake.calls).toContainEqual(["logs_close", 9]);
});
