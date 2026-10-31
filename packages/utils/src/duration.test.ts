import { expect, test } from "vitest";
import { humanDuration } from "./duration";

const s = 1000;
const m = 60 * s;
const h = 60 * m;
const d = 24 * h;

test.each([
  [-2 * s, "<invalid>"],
  [-1 * s, "0s"],
  [0, "0s"],
  [119 * s, "119s"],
  [2 * m, "2m"],
  [9 * m + 59 * s, "9m59s"],
  [10 * m + 30 * s, "10m"],
  [179 * m, "179m"],
  [3 * h, "3h"],
  [7 * h + 59 * m, "7h59m"],
  [8 * h + 30 * m, "8h"],
  [47 * h, "47h"],
  [2 * d, "2d"],
  [7 * d + 23 * h, "7d23h"],
  [8 * d + 5 * h, "8d"],
  [729 * d, "729d"],
  [730 * d, "2y"],
  [731 * d, "2y1d"],
  [8 * 365 * d, "8y"],
])("%d ms is %s", (ms, want) => {
  expect(humanDuration(ms)).toBe(want);
});
