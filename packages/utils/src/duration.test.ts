import { expect, test } from "vitest";
import { humanDuration, parseDuration } from "./duration";

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

test.each([
  ["0s", 0],
  ["13s", 13 * s],
  ["119s", 119 * s],
  ["5m", 5 * m],
  ["9m59s", 9 * m + 59 * s],
  ["179m", 179 * m],
  ["3h", 3 * h],
  ["7h59m", 7 * h + 59 * m],
  ["47h", 47 * h],
  ["2d", 2 * d],
  ["2d1h", 2 * d + h],
  ["7d23h", 7 * d + 23 * h],
  ["729d", 729 * d],
  ["2y", 730 * d],
  ["2y1d", 731 * d],
])("%s parses to %d ms", (text, want) => {
  expect(parseDuration(text)).toBe(want);
});

test.each([
  "",
  "<invalid>",
  "<unknown>",
  "5",
  "m5",
  "5x",
  "1h2d",
  "5m 3s",
  "-3s",
])("%j is not a duration kubectl prints", (text) => {
  expect(parseDuration(text)).toBeUndefined();
});

test.each([
  13 * s,
  5 * m + 30 * s,
  47 * m,
  5 * h + 20 * m,
  30 * h,
  3 * d + 7 * h,
  200 * d,
  731 * d,
])("what humanDuration prints for %d ms reads back to it", (ms) => {
  expect(parseDuration(humanDuration(ms))).toBe(ms);
});
