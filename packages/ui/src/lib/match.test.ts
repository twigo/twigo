import { expect, test } from "vitest";
import { fuzzyMatch } from "./match";

test("matched characters in a row merge into one range, and apart ones stay apart", () => {
  expect(fuzzyMatch("gateway", "gate")?.ranges).toEqual([{ start: 0, end: 4 }]);
  expect(fuzzyMatch("api-gateway", "apigw")?.ranges).toEqual([
    { start: 0, end: 3 },
    { start: 4, end: 5 },
    { start: 8, end: 9 },
  ]);
});

test("each word of the search matches on its own, and the ranges keep the text's order", () => {
  expect(fuzzyMatch("api-gateway", "gate api")?.ranges).toEqual([
    { start: 0, end: 3 },
    { start: 4, end: 8 },
  ]);
});

test("the text itself scores 1 and a looser match less, while no match and an empty search give nothing", () => {
  expect(fuzzyMatch("pods", "pods")?.score).toBe(1);
  expect(fuzzyMatch("pods", "pd")?.score).toBeLessThan(1);
  expect(fuzzyMatch("pods", "xyz")).toBeUndefined();
  expect(fuzzyMatch("pods", "")).toBeUndefined();
});
