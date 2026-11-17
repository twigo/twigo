import { expect, test } from "vitest";
import CASES from "../printed-cases.json";
import { keepsStamp } from "./printed";

test("a stamp dates a print as the shared cases say", () => {
  const wrong = CASES.cases.flatMap(
    ({ name, held, heldAt, printed, at, keeps }) =>
      keepsStamp(held, heldAt, printed, at) === keeps ? [] : [name],
  );
  expect(wrong).toEqual([]);
});
