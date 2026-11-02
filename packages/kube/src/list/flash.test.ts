import { expect, test } from "vitest";
import { INITIAL_SNAPSHOT, type ListSnapshot } from "@twigo/protocol";
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
  const flash = new FlashTracker();
  flash.record(changed(1, 1), 0);
  flash.record(changed(2, 0), 500);
  expect(flash.since("r0", 2)).toBe(0);
  expect(flash.since("r0", 1)).toBeUndefined();
  flash.record(changed(3, 0), 1000);
  expect(flash.since("r0", 2)).toBeUndefined();
});

test("a batch that changes more rows than the limit flashes nothing", () => {
  const flash = new FlashTracker();
  flash.record(changed(1, FLASH_ROW_LIMIT), 0);
  expect(flash.since("r0", 2)).toBe(0);
  flash.record(changed(2, FLASH_ROW_LIMIT + 1), 100);
  expect(flash.since("r0", 2)).toBe(0);
  expect(flash.since(`r${String(FLASH_ROW_LIMIT)}`, 2)).toBeUndefined();
});

test("the same snapshot is recorded once", () => {
  const flash = new FlashTracker();
  const snapshot = changed(1, 1);
  flash.record(snapshot, 0);
  flash.record(snapshot, 1500);
  expect(flash.since("r0", 2)).toBe(0);
});
