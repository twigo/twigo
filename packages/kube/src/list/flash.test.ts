import { expect, test } from "vitest";
import { INITIAL_SNAPSHOT, type ListSnapshot } from "@twigo/protocol";
import { PODS } from "../kinds";
import { FLASH_ROW_LIMIT, FlashTracker } from "./flash";

const POD_COLUMNS = [
  { name: "Name", kind: "string", priority: 0 },
  { name: "Ready", kind: "string", priority: 0 },
  { name: "Restarts", kind: "string", priority: 0 },
] as const;

function changed(seq: number, rows: number, cells = [2]): ListSnapshot {
  return {
    ...INITIAL_SNAPSHOT,
    seq,
    columns: POD_COLUMNS,
    changed: new Map(
      Array.from({ length: rows }, (_, i) => [`r${String(i)}`, cells]),
    ),
  };
}

test("a changed cell flashes through the batches of its second, and is forgotten after", () => {
  const flash = new FlashTracker(PODS);
  flash.record(changed(1, 1), 0);
  flash.record(changed(2, 0), 500);
  expect(flash.of("r0")?.get("Restarts")).toBe(0);
  expect(flash.of("r0")?.get("Ready")).toBeUndefined();
  flash.record(changed(3, 0), 1000);
  expect(flash.of("r0")).toBeUndefined();
});

test("a row's flashes stay the same map until one of them starts or ends, and a row with none has none", () => {
  const flash = new FlashTracker(PODS);
  flash.record(changed(1, 1), 0);
  const first = flash.of("r0");
  flash.record(changed(2, 0), 500);
  expect(flash.of("r0")).toBe(first);
  flash.record(changed(3, 1, [1]), 600);
  const both = flash.of("r0");
  expect(both).not.toBe(first);
  expect([...(both ?? [])]).toEqual([
    ["Restarts", 0],
    ["Ready", 600],
  ]);
  flash.record(changed(4, 0), 1000);
  expect([...(flash.of("r0") ?? [])]).toEqual([["Ready", 600]]);
  expect(flash.of("r1")).toBeUndefined();
});

test("a flash stays with its column when the columns change within its second", () => {
  const flash = new FlashTracker(PODS);
  flash.record(changed(1, 1), 0);
  flash.record(
    {
      ...changed(2, 0),
      columns: [
        POD_COLUMNS[0],
        { name: "CPU", kind: "cpu", priority: 0 },
        POD_COLUMNS[1],
        POD_COLUMNS[2],
      ],
    },
    500,
  );
  expect([...(flash.of("r0") ?? [])]).toEqual([["Restarts", 0]]);
});

test("a batch that changes more rows than the limit flashes nothing", () => {
  const flash = new FlashTracker(PODS);
  flash.record(changed(1, FLASH_ROW_LIMIT), 0);
  expect(flash.of("r0")?.get("Restarts")).toBe(0);
  flash.record(changed(2, FLASH_ROW_LIMIT + 1), 100);
  expect(flash.of("r0")?.get("Restarts")).toBe(0);
  expect(flash.of(`r${String(FLASH_ROW_LIMIT)}`)).toBeUndefined();
});

test("the same snapshot is recorded once", () => {
  const flash = new FlashTracker(PODS);
  const snapshot = changed(1, 1);
  flash.record(snapshot, 0);
  flash.record(snapshot, 1500);
  expect(flash.of("r0")?.get("Restarts")).toBe(0);
});

test("a measure that moves at every poll flashes nothing and counts for no row", () => {
  const columns = [
    { name: "Name", kind: "string", priority: 0 },
    { name: "Restarts", kind: "string", priority: 0 },
    { name: "CPU", kind: "cpu", priority: 0 },
  ] as const;
  const rows = (cells: number[], count: number): ListSnapshot => ({
    ...INITIAL_SNAPSHOT,
    seq: count + cells.length,
    columns,
    changed: new Map(
      Array.from({ length: count }, (_, i) => [`r${String(i)}`, cells]),
    ),
  });
  const flash = new FlashTracker(PODS);
  flash.record(rows([2], FLASH_ROW_LIMIT + 5), 0);
  expect(flash.of("r0")).toBeUndefined();
  flash.record(rows([1, 2], 1), 100);
  expect(flash.of("r0")?.get("Restarts")).toBe(100);
  expect(flash.of("r0")?.get("CPU")).toBeUndefined();
  flash.record(rows([1, 2], FLASH_ROW_LIMIT), 200);
  expect(flash.of("r1")?.get("Restarts")).toBe(200);
});
