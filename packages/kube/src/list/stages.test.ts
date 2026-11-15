import { expect, test } from "vitest";
import { stageFor } from "./stages";

const LAST = 4;

const NEEDS = [700, 660, 600, 440, 330];

function settle(room: number, from = 0, known: (number | undefined)[] = []) {
  let stage = from;
  const needs = [...known];
  for (let steps = 0; steps < 20; steps++) {
    needs[stage] = NEEDS[stage];
    const next = stageFor(needs, stage, room, LAST);
    if (next === stage) return { stage, needs };
    stage = next;
  }
  throw new Error("never settled");
}

test("a row that fits stays in its fullest stage", () => {
  expect(settle(700).stage).toBe(0);
  expect(settle(2000).stage).toBe(0);
});

test("a row steps to the next stage until it fits, and stays in the last when nothing does", () => {
  expect(settle(699).stage).toBe(1);
  expect(settle(660).stage).toBe(1);
  expect(settle(599).stage).toBe(3);
  expect(settle(439).stage).toBe(4);
  expect(settle(100).stage).toBe(LAST);
});

test("a row that narrowed returns to the fullest stage that fits as the room grows, and only then", () => {
  const narrow = settle(330);
  expect(narrow.stage).toBe(4);
  let stage = narrow.stage;
  for (const [room, expected] of [
    [439, 4],
    [440, 3],
    [599, 3],
    [600, 2],
    [660, 1],
    [700, 0],
  ] as const) {
    stage = stageFor(narrow.needs, stage, room, LAST);
    while (stage > 0 && narrow.needs[stage] === undefined) stage--;
    expect(stage).toBe(expected);
  }
});

test("a stage not shown yet is tried before the room is given up on", () => {
  expect(stageFor([700], 0, 500, LAST)).toBe(1);
  expect(stageFor([700, undefined], 1, 500, LAST)).toBe(1);
  expect(stageFor([700, 660], 1, 500, LAST)).toBe(2);
});

test("a stage that proves wider than it was learnt to be is left again at once", () => {
  expect(stageFor([620, 500], 1, 650, LAST)).toBe(0);
  expect(stageFor([700, 500], 0, 650, LAST)).toBe(1);
});
