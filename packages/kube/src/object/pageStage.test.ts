import { renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import { LABEL_COLUMN } from "./ObjectContent";
import {
  FULL_PAGE,
  LABEL_WIDTH,
  stands,
  TWO_COLUMNS,
  useFits,
} from "./pageStage";

test("the full page comes at 900 px and, once drawn, stays down to 884", () => {
  expect(FULL_PAGE).toBe(900);
  expect(stands(899, false, FULL_PAGE)).toBe(false);
  expect(stands(900, false, FULL_PAGE)).toBe(true);
  expect(stands(884, true, FULL_PAGE)).toBe(true);
  expect(stands(883, true, FULL_PAGE)).toBe(false);
  expect(stands(890, false, FULL_PAGE)).toBe(false);
});

test("the main column's two property columns follow the same margin", () => {
  expect(stands(TWO_COLUMNS - 1, false, TWO_COLUMNS)).toBe(false);
  expect(stands(TWO_COLUMNS, false, TWO_COLUMNS)).toBe(true);
  expect(stands(TWO_COLUMNS - 16, true, TWO_COLUMNS)).toBe(true);
  expect(stands(TWO_COLUMNS - 17, true, TWO_COLUMNS)).toBe(false);
});

test("two property columns start where each value gets 225 px: a main column of 750", () => {
  expect(TWO_COLUMNS).toBe(750);
  expect(LABEL_COLUMN).toBe(`[--label-column:${String(LABEL_WIDTH)}px]`);
});

test("a form that measures 0 fits nowhere, and comes back only with the margin met", () => {
  const { result, rerender } = renderHook(
    ({ room, natural }) => useFits(room, natural),
    { initialProps: { room: 100, natural: 50 } },
  );
  expect(result.current).toBe(true);
  rerender({ room: 100, natural: 0 });
  expect(result.current).toBe(false);
  rerender({ room: 100, natural: 90 });
  expect(result.current).toBe(false);
  rerender({ room: 106, natural: 90 });
  expect(result.current).toBe(true);
  rerender({ room: 100, natural: 90 });
  expect(result.current).toBe(true);
  rerender({ room: 0, natural: 90 });
  expect(result.current).toBe(false);
  rerender({ room: 100, natural: 90 });
  expect(result.current).toBe(false);
});
