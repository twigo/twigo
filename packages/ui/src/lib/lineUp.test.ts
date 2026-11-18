import { expect, test } from "vitest";
import { lineUp } from "./lineUp";

test("rows fill a line left to right, and a stacked one takes the whole line and starts the next", () => {
  expect(lineUp([false, false, false, true, false, false])).toEqual([
    "left",
    "right",
    "left",
    "full",
    "left",
    "right",
  ]);
  expect(lineUp([true, true, false])).toEqual(["full", "full", "left"]);
  expect(lineUp([])).toEqual([]);
});
