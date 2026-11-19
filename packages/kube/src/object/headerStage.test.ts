import { expect, test } from "vitest";
import { fitStage, PLACE_STAGES, TITLE_STAGES } from "./headerStage";

const needs = [400, 330, 250, 180];

test("each line takes the fullest of its stages whose width fits, the last when none does", () => {
  expect(fitStage(needs, 500, 0)).toBe(0);
  expect(fitStage(needs, 401, 0)).toBe(0);
  expect(fitStage(needs, 400, 0)).toBe(1);
  expect(fitStage(needs, 331, 0)).toBe(1);
  expect(fitStage(needs, 251, 0)).toBe(2);
  expect(fitStage(needs, 181, 0)).toBe(3);
  expect(fitStage(needs, 100, 0)).toBe(3);
});

test("a stage holds a pixel for the two widths each rounded to one", () => {
  expect(fitStage([100, 80], 101, 0)).toBe(0);
  expect(fitStage([100, 80], 100, 0)).toBe(1);
});

test("a fuller stage comes back only with 16 px to spare", () => {
  expect(fitStage(needs, 400 + 1 + 15, 1)).toBe(1);
  expect(fitStage(needs, 400 + 1 + 16, 1)).toBe(0);
  expect(fitStage(needs, 330 + 1 + 15, 2)).toBe(2);
  expect(fitStage(needs, 330 + 1 + 16, 2)).toBe(1);
  expect(fitStage(needs, 400 + 1 + 16, 2)).toBe(0);
});

test("the stage stays as it was until the room and every stage are measured", () => {
  expect(fitStage(needs, 0, 2)).toBe(2);
  expect(fitStage([], 300, 1)).toBe(1);
  expect(fitStage([400, 0, 250, 180], 300, 1)).toBe(1);
});

test("the first line drops the kind word before it cuts the name in the middle, the name giving up its hash first", () => {
  expect(
    TITLE_STAGES.map(({ kind, name }) => `${String(kind)} ${name}`),
  ).toEqual(["true whole", "true hash", "false hash", "false middle"]);
});

test("the second line cuts one text at a stage and holds the one before it at its floor", () => {
  expect(
    PLACE_STAGES.map(({ namespace, ownerKind, owner, node }) => [
      namespace,
      ownerKind,
      owner,
      node,
    ]),
  ).toEqual([
    ["whole", true, "whole", "whole"],
    ["whole", true, "whole", "cut"],
    ["whole", true, "cut", "floor"],
    ["whole", false, "cut", "floor"],
    ["whole", false, "cut", "left"],
    ["cut", false, "floor", "left"],
  ]);
});
