import { expect, test } from "vitest";
import type {
  Backend,
  Cell,
  Column,
  ForwardEvent,
  ListBatch,
  Row,
  ShellMessage,
} from "@twigo/protocol";
import { type CellChange, ListProbe, Probe, ShellProbe } from "./probe";

const COLUMNS: Column[] = [
  { name: "Name", kind: "string", priority: 0 },
  { name: "Status", kind: "string", priority: 0 },
  { name: "Restarts", kind: "integer", priority: 0 },
];

function row(id: string, cells: Cell[]): Row {
  return {
    id,
    created: null,
    received: "2026-11-16T12:00:00.000Z",
    generated: null,
    cells,
  };
}

function batch(rest: Partial<ListBatch>): ListBatch {
  return {
    seq: 1,
    view: 0,
    total: 3,
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

function recorded(probe: ListProbe, at: number, next: ListBatch) {
  const seen: [number, ListBatch, readonly CellChange[]][] = [];
  const stop = probe.listen((...args) => seen.push(args));
  probe.record(at, next);
  stop();
  return seen;
}

function opened(): ListProbe {
  const probe = new ListProbe();
  probe.record(
    10,
    batch({
      columns: COLUMNS,
      window: { start: 0, ids: ["a", "b", "c"] },
      upserts: [
        row("a", ["a", "Running", 0]),
        row("b", ["b", "Pending", 1]),
        row("c", ["c", "Running", null]),
      ],
    }),
  );
  return probe;
}

test("the first batch sets the columns, total, window and cells, and changes nothing", () => {
  const probe = new ListProbe();
  const first = batch({
    columns: COLUMNS,
    window: { start: 0, ids: ["a", "b"] },
    upserts: [row("a", ["a", "Running", 0]), row("b", ["b", "Pending", 1])],
  });
  expect(recorded(probe, 10, first)).toEqual([[10, first, []]]);
  expect(probe.columns).toEqual(COLUMNS);
  expect(probe.total).toBe(3);
  expect(probe.ids).toEqual(["a", "b"]);
  expect(probe.cells("b")).toEqual(["b", "Pending", 1]);
});

test("a changed cell is reported with its column and text, and unchanged ones are not", () => {
  const probe = opened();
  const seen = recorded(
    probe,
    20,
    batch({
      seq: 2,
      upserts: [row("a", ["a", "Running", 1]), row("b", ["b", "Running", 1])],
    }),
  );
  expect(seen.map(([at, , changed]) => [at, changed])).toEqual([
    [
      20,
      [
        { id: "a", column: "Restarts", text: "1" },
        { id: "b", column: "Status", text: "Running" },
      ],
    ],
  ]);
  expect(probe.cells("a")).toEqual(["a", "Running", 1]);
});

test("a cell that becomes empty reads as an empty string", () => {
  const probe = opened();
  const [[, , changed] = []] = recorded(
    probe,
    20,
    batch({ upserts: [row("b", ["b", "Pending", null])] }),
  );
  expect(changed).toEqual([{ id: "b", column: "Restarts", text: "" }]);
});

test("a row seen for the first time is not a change", () => {
  const probe = opened();
  const [[, , changed] = []] = recorded(
    probe,
    20,
    batch({ total: 4, upserts: [row("d", ["d", "Running", 0])] }),
  );
  expect(changed).toEqual([]);
  expect(probe.cells("d")).toEqual(["d", "Running", 0]);
  expect(probe.total).toBe(4);
});

test("a batch without columns or window keeps the previous ones", () => {
  const probe = opened();
  probe.record(20, batch({ upserts: [row("a", ["a", "Error", 0])] }));
  expect(probe.columns).toEqual(COLUMNS);
  expect(probe.ids).toEqual(["a", "b", "c"]);
});

test("indexOf counts from the window's start, and is -1 outside the window", () => {
  const probe = opened();
  probe.record(20, batch({ window: { start: 40, ids: ["c", "a"] } }));
  expect(probe.indexOf("c")).toBe(40);
  expect(probe.indexOf("a")).toBe(41);
  expect(probe.indexOf("b")).toBe(-1);
});

test("a listener stops hearing batches once removed", () => {
  const probe = opened();
  const heard: number[] = [];
  const stop = probe.listen((at) => heard.push(at));
  probe.record(20, batch({}));
  stop();
  probe.record(30, batch({}));
  expect(heard).toEqual([20]);
});

test("the next view change sent for a list resolves with its number, and another list's does not", async () => {
  let opened = 0;
  const inner: Backend = {
    invoke: () => Promise.resolve(null as never),
    subscribe: () => Promise.resolve(++opened as never),
  };
  const probe = new Probe(inner);
  const next = probe.next();
  const one = probe.backend.subscribe(
    "list_subscribe",
    {} as never,
    () => undefined,
  );
  const list = await next;
  const two = probe.backend.subscribe(
    "list_subscribe",
    {} as never,
    () => undefined,
  );
  const [a, b] = [await one, await two];
  const heard: number[] = [];
  void list.nextView().then((view) => heard.push(view));
  const shape = {
    text: null,
    columns: null,
    sort: null,
    countBy: null,
    groupBy: null,
    values: null,
  };
  await probe.backend.invoke("list_set_view", { id: b, view: 9, ...shape });
  await Promise.resolve();
  expect(heard).toEqual([]);
  await probe.backend.invoke("list_set_view", { id: a, view: 4, ...shape });
  await Promise.resolve();
  expect(heard).toEqual([4]);
});

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

test("a session's state is what its last event said, and its output is counted and kept at its end", () => {
  const shell = new ShellProbe(3);
  expect(shell.state).toEqual({ state: "connecting" });
  shell.record(10, { state: "running" });
  shell.record(20, bytes("a".repeat(3000)));
  shell.record(30, bytes("b".repeat(3000)));
  expect(shell.state).toEqual({ state: "running" });
  expect(shell.bytes).toBe(6000);
  expect(shell.lastAt).toBe(30);
  expect(shell.tail).toHaveLength(4000);
  expect(shell.tail.endsWith("bbb")).toBe(true);
  expect(shell.tail.startsWith("a")).toBe(true);
});

test("a session's output is counted in lines, whatever the chunks cut", () => {
  const shell = new ShellProbe(3);
  shell.record(1, bytes("one\r\ntw"));
  shell.record(2, bytes("o\r\n\r\nthree"));
  expect(shell.lines).toBe(3);
  expect(shell.bytes).toBe(17);
});

test("a character that a chunk cuts in two is decoded whole in the output's end", () => {
  const shell = new ShellProbe(3);
  const [first, second] = [
    new Uint8Array([0xe2, 0x82]).buffer,
    new Uint8Array([0xac]).buffer,
  ];
  shell.record(1, first);
  shell.record(2, second);
  expect(shell.tail).toBe("\u20ac");
});

test("a shell's channel is recorded as it opens and passed on to the terminal", async () => {
  let send: ((message: ShellMessage) => void) | undefined;
  const inner: Backend = {
    invoke: () => Promise.resolve(null as never),
    subscribe: (_command, _request, onMessage) => {
      send = onMessage;
      return Promise.resolve(null as never);
    },
  };
  const probe = new Probe(inner);
  const heard: ShellMessage[] = [];
  await probe.backend.subscribe(
    "shell_open",
    { id: 9, cols: 80, rows: 24 },
    (message) => heard.push(message),
  );
  send?.({ state: "running" });
  send?.(bytes("hi"));
  expect(
    probe.shells.map((shell) => [shell.id, shell.state, shell.bytes]),
  ).toEqual([[9, { state: "running" }, 2]]);
  expect(heard).toHaveLength(2);
});

test("what a terminal's creation and a forward's start answered is kept", async () => {
  const created = { id: 4, kind: { kind: "proxy", why: "mode" } };
  const started = { outcome: "busy", local: 8080, why: "inUse", free: 8081 };
  const inner: Backend = {
    invoke: ((command: string) =>
      Promise.resolve(
        command === "terminal_create" ? created : started,
      )) as Backend["invoke"],
    subscribe: () => Promise.resolve(null as never),
  };
  const probe = new Probe(inner);
  await probe.backend.invoke("terminal_create", {} as never);
  await probe.backend.invoke("forward_start", {} as never);
  expect(probe.terminal).toEqual(created);
  expect(probe.forwardStarted).toEqual(started);
});

test("the forwards the core tells of are kept until it removes them", async () => {
  let send: ((event: ForwardEvent) => void) | undefined;
  const inner: Backend = {
    invoke: () => Promise.resolve(null as never),
    subscribe: (_command, _request, onMessage) => {
      send = onMessage;
      return Promise.resolve([] as never);
    },
  };
  const probe = new Probe(inner);
  await probe.backend.subscribe("forwards_watch", null, () => undefined);
  const forward = { id: 2, state: { state: "starting" } } as never;
  send?.({ event: "changed", forward });
  expect([...probe.forwards.keys()]).toEqual([2]);
  send?.({ event: "removed", id: 2 });
  expect(probe.forwards.size).toBe(0);
});
