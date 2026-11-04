import { expect, test } from "vitest";
import { sameData } from "./same";

test("plain data built alike is the same, and any value apart tells it apart", () => {
  expect(
    sameData(
      { type: "seconds", seconds: 900 },
      { type: "seconds", seconds: 900 },
    ),
  ).toBe(true);
  expect(
    sameData(
      { type: "seconds", seconds: 900 },
      { type: "seconds", seconds: 300 },
    ),
  ).toBe(false);
  expect(sameData({ pods: null }, { pods: ["a"] })).toBe(false);
});
