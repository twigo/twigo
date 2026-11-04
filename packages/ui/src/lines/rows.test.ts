import { renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import { leftOf, useKeptSizes, useRowKeys, type Loaded } from "./rows";

const keys = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, at) => String(from + at));

test.each<
  [
    string,
    Loaded,
    { start: number; keys: string[]; reach: number; total: number },
    [number, string][],
  ]
>([
  [
    "a window that moves on keeps the lines that left it within reach",
    { start: 0, keys: keys(0, 10), left: new Map() },
    { start: 5, keys: keys(5, 15), reach: 3, total: 100 },
    [
      [2, "2"],
      [3, "3"],
      [4, "4"],
    ],
  ],
  [
    "the bound dropping lines before the window moves those that left with them",
    {
      start: 10,
      keys: keys(10, 20),
      left: new Map([
        [8, "8"],
        [9, "9"],
      ]),
    },
    { start: 7, keys: keys(10, 20), reach: 100, total: 97 },
    [
      [5, "8"],
      [6, "9"],
    ],
  ],
  [
    "lines the bound dropped from the head of the view stand before its first and are not kept",
    { start: 0, keys: keys(0, 10), left: new Map() },
    { start: 0, keys: keys(3, 13), reach: 100, total: 100 },
    [],
  ],
  [
    "a lagging stream merging lines in moves those below them that left, and not those above",
    {
      start: 2,
      keys: ["b", "c", "d", "e", "f"],
      left: new Map([
        [1, "a"],
        [7, "g"],
      ]),
    },
    { start: 2, keys: ["b", "c", "x", "d", "e"], reach: 100, total: 9 },
    [
      [1, "a"],
      [7, "f"],
      [8, "g"],
    ],
  ],
  [
    "lines that left past the end of the view are not kept",
    { start: 0, keys: ["a", "b", "c", "d", "e"], left: new Map() },
    { start: 0, keys: ["a", "b", "c"], reach: 100, total: 4 },
    [[3, "d"]],
  ],
  [
    "a window with no line in common with the one before keeps none",
    { start: 0, keys: ["a", "b"], left: new Map([[2, "c"]]) },
    { start: 100, keys: ["x", "y"], reach: 1000, total: 1000 },
    [],
  ],
])("%s", (_, was, now, left) => {
  expect(leftOf(was, now.start, now.keys, now.reach, now.total)).toEqual(
    new Map(left),
  );
});

test("following, the rows keep the keys of the loaded lines and of those within reach that left them, and no others", () => {
  const { result, rerender } = renderHook(
    ({ end }: { end: number }) =>
      useRowKeys(end - 40, keys(end - 40, end), end, 72),
    { initialProps: { end: 100 } },
  );
  for (let end = 110; end <= 600; end += 10) rerender({ end });
  expect(result.current.kept).toEqual(new Set(keys(600 - 40 - 72, 600)));
});

test("paused at the head of a bounded buffer as lines come, the rows keep the keys of the loaded lines alone", () => {
  const { result, rerender } = renderHook(
    ({ first }: { first: number }) =>
      useRowKeys(0, keys(first, first + 112), 300, 300),
    { initialProps: { first: 0 } },
  );
  for (let first = 10; first <= 1000; first += 10) rerender({ first });
  expect(result.current.kept).toEqual(new Set(keys(1000, 1112)));
});

test("a row's key is its line's, else that of a line that left there, else one of its index apart from any line's, from the same function until the window changes", () => {
  const { result, rerender } = renderHook(
    ({ start }: { start: number }) =>
      useRowKeys(start, keys(start, start + 10), 100, 100),
    { initialProps: { start: 0 } },
  );
  rerender({ start: 5 });
  const { keyOf } = result.current;
  expect([keyOf(5), keyOf(2), keyOf(50)]).toEqual(["5", "2", "#50"]);
  rerender({ start: 5 });
  expect(result.current.keyOf).toBe(keyOf);
  rerender({ start: 6 });
  expect(result.current.keyOf).not.toBe(keyOf);
});

test("only the rows kept keep their sizes, a blank row's included", () => {
  const virtualizer = {
    itemSizeCache: new Map<string | number | bigint, number>([
      ["4", 38],
      ["9", 38],
      [12, 19],
    ]),
  };
  renderHook(() => {
    useKeptSizes(virtualizer, new Set(["4"]));
  });
  expect([...virtualizer.itemSizeCache.keys()]).toEqual(["4"]);
});
