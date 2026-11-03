import { expect, test } from "vitest";
import type { RowGroup } from "@twigo/protocol";
import { sequence } from "./sequence";

const group = (value: string, rows: number): RowGroup => ({
  value,
  rows,
  counts: [],
});

test("without groups every item is a row", () => {
  const items = sequence(undefined, new Set(), 3);
  expect(items.length).toBe(3);
  expect(items.at(2)).toEqual({ type: "row", row: 2 });
  expect(items.at(3)).toBeUndefined();
  expect(items.rows(1, 3)).toEqual([1, 3]);
});

test("each group's header comes before its rows, and a collapsed group takes only its header", () => {
  const groups = [group("auth", 2), group("edge", 3), group("payments", 1)];
  const items = sequence(groups, new Set(["edge"]), 6);
  // auth: header 0, rows 1-2; edge: header 3; payments: header 4, row 5.
  expect(items.length).toBe(6);
  expect(items.at(0)).toEqual({ type: "group", group: groups[0], open: true });
  expect(items.at(2)).toEqual({ type: "row", row: 1 });
  expect(items.at(3)).toEqual({ type: "group", group: groups[1], open: false });
  expect(items.at(4)).toEqual({ type: "group", group: groups[2], open: true });
  expect(items.at(5)).toEqual({ type: "row", row: 2 });
  expect(items.itemOf(0)).toBe(1);
  expect(items.itemOf(2)).toBe(5);
});

test("the rows behind a range of items skip the headers", () => {
  const groups = [group("auth", 2), group("edge", 3), group("payments", 1)];
  const items = sequence(groups, new Set(["edge"]), 6);
  expect(items.rows(0, 6)).toEqual([0, 3]);
  expect(items.rows(2, 5)).toEqual([1, 2]);
  expect(items.rows(3, 4)).toEqual([2, 2]);
  const open = sequence(groups, new Set(), 6);
  // auth 0-2, edge 3-6, payments 7-8.
  expect(open.length).toBe(9);
  expect(open.rows(4, 8)).toEqual([2, 5]);
  expect(open.itemOf(4)).toBe(6);
});
