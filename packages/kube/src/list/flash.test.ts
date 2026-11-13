import { expect, test } from "vitest";
import { INITIAL_SNAPSHOT, type ListSnapshot } from "@twigo/protocol";
import { PODS } from "../kinds";
import { FLASH_ROW_LIMIT, FlashTracker } from "./flash";

function changed(seq: number, rows: number): ListSnapshot {
  return {
    ...INITIAL_SNAPSHOT,
    seq,
    changed: new Map(
      Array.from({ length: rows }, (_, i) => [`r${String(i)}`, [2]]),
    ),
  };
}

test("a changed cell flashes through the batches of its second, and is forgotten after", () => {
  const flash = new FlashTracker(PODS);
  flash.record(changed(1, 1), 0);
  flash.record(changed(2, 0), 500);
  expect(flash.since("r0", 2)).toBe(0);
  expect(flash.since("r0", 1)).toBeUndefined();
  flash.record(changed(3, 0), 1000);
  expect(flash.since("r0", 2)).toBeUndefined();
});

test("a batch that changes more rows than the limit flashes nothing", () => {
  const flash = new FlashTracker(PODS);
  flash.record(changed(1, FLASH_ROW_LIMIT), 0);
  expect(flash.since("r0", 2)).toBe(0);
  flash.record(changed(2, FLASH_ROW_LIMIT + 1), 100);
  expect(flash.since("r0", 2)).toBe(0);
  expect(flash.since(`r${String(FLASH_ROW_LIMIT)}`, 2)).toBeUndefined();
});

test("the same snapshot is recorded once", () => {
  const flash = new FlashTracker(PODS);
  const snapshot = changed(1, 1);
  flash.record(snapshot, 0);
  flash.record(snapshot, 1500);
  expect(flash.since("r0", 2)).toBe(0);
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
  expect(flash.since("r0", 2)).toBeUndefined();
  flash.record(rows([1, 2], 1), 100);
  expect(flash.since("r0", 1)).toBe(100);
  expect(flash.since("r0", 2)).toBeUndefined();
  flash.record(rows([1, 2], FLASH_ROW_LIMIT), 200);
  expect(flash.since("r1", 1)).toBe(200);
});
