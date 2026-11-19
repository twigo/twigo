import { expect, test } from "vitest";
import { humanDuration, parseDuration, widestDuration } from "./duration";

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

test("the widest text of a range is what its widest age prints, and the range changes where the forms do", () => {
  const ranges: [number, string][] = [
    [-2 * s, "<invalid>"],
    [-10 * m, "<invalid>"],
    [-1999, "119s"],
    [-s, "119s"],
    [119 * s, "119s"],
    [2 * m, "9m59s"],
    [9 * m + 59 * s, "9m59s"],
    [10 * m, "179m"],
    [179 * m + 59 * s, "179m"],
    [3 * h, "7h59m"],
    [7 * h + 59 * m, "7h59m"],
    [8 * h, "47h"],
    [47 * h + 59 * m, "47h"],
    [2 * d, "7d23h"],
    [7 * d + 23 * h, "7d23h"],
    [8 * d, "729d"],
    [729 * d, "729d"],
    [730 * d, "7y364d"],
    [8 * 365 * d - s, "7y364d"],
    [8 * 365 * d, "99y"],
  ];
  for (const [ms, widest] of ranges) expect(widestDuration(ms)).toBe(widest);
  for (const widest of new Set(ranges.map(([, wide]) => wide))) {
    if (widest === "99y") continue;
    const ages = ranges
      .filter(([, wide]) => wide === widest)
      .map(([ms]) => humanDuration(ms));
    expect(Math.max(...ages.map((age) => age.length))).toBeLessThanOrEqual(
      widest.length,
    );
  }
  expect(
    [119 * s, 9 * m + 59 * s, 179 * m, 7 * h + 59 * m, 47 * h].map(
      humanDuration,
    ),
  ).toEqual(["119s", "9m59s", "179m", "7h59m", "47h"]);
  expect([7 * d + 23 * h, 729 * d, 8 * 365 * d - d].map(humanDuration)).toEqual(
    ["7d23h", "729d", "7y364d"],
  );
});

test("an age is never wider than the widest text of its range, in characters and in units", () => {
  const units = (text: string) => text.replace(/\d/g, "");
  const wider: number[] = [];
  const check = (ms: number) => {
    const age = humanDuration(ms);
    const widest = widestDuration(ms);
    if (
      age.length > widest.length ||
      units(age)
        .split("")
        .some((unit) => !widest.includes(unit))
    )
      wider.push(ms);
  };
  for (let ms = -10 * s; ms < 3 * d; ms += s) check(ms);
  for (let ms = 3 * d; ms < 9 * 365 * d; ms += 7 * m + 13 * s) check(ms);
  expect(wider).toEqual([]);
});

test("an age keeps the widest text of its range as it ticks from 2m59s to 4m", () => {
  const ages = [2 * m + 59 * s, 3 * m, 3 * m + 10 * s, 4 * m];
  expect(ages.map(humanDuration)).toEqual(["2m59s", "3m", "3m10s", "4m"]);
  expect(new Set(ages.map(widestDuration))).toEqual(new Set(["9m59s"]));
});
