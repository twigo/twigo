import { expect, test } from "vitest";
import { FILTER_STAGES, fitFilter } from "./filterStage";

const widths = { views: 289, long: 135, short: 32 };

test("the field sits beside the views while the row leaves it room, with the count short before it goes to a line of its own", () => {
  expect(fitFilter({ ...widths, row: 800 }, 0)).toBe(0);
  expect(fitFilter({ ...widths, row: 470 }, 0)).toBe(1);
  expect(fitFilter({ ...widths, row: 360 }, 0)).toBe(2);
  expect(fitFilter({ ...widths, row: 320 }, 0)).toBe(2);
  expect(FILTER_STAGES.map(({ beside }) => beside)).toEqual([
    true,
    true,
    false,
    false,
  ]);
});

test("a row too narrow for the long count on a line of its own words it short", () => {
  expect(fitFilter({ ...widths, row: 240 }, 2)).toBe(3);
});

test("a fuller stage comes back only with a margin to spare", () => {
  const stage = (row: number, current: number) =>
    fitFilter({ ...widths, row }, current);
  const roomy = 289 + 112 + 6 + 135 + 6;
  expect(stage(roomy - 1, 0)).toBe(1);
  expect(stage(roomy, 1)).toBe(1);
  expect(stage(roomy + 16, 1)).toBe(0);
  expect(stage(roomy, 0)).toBe(0);
});

test("the stage stays as it was until the row and the views are measured", () => {
  expect(fitFilter({ ...widths, row: 0 }, 2)).toBe(2);
  expect(fitFilter({ ...widths, row: 470, views: 0 }, 3)).toBe(3);
});
