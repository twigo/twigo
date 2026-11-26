import { expect, test } from "vitest";
import type { Backend, Cell, Column, ListBatch, Row } from "@twigo/protocol";
import { type CellChange, ListProbe, Probe } from "./probe";

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

test("a batch sets the view the list reflects", () => {
  const probe = opened();
  expect(probe.view).toBe(0);
  probe.record(20, batch({ view: 3 }));
  expect(probe.view).toBe(3);
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
