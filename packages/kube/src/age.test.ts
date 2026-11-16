import { expect, test } from "vitest";
import { ageRole, restartedRecently } from "./age";

const MINUTE = 60_000;

test("an age under ten minutes is in content and an older one in support", () => {
  expect(ageRole(10 * MINUTE - 1)).toBe("text-content");
  expect(ageRole(10 * MINUTE)).toBe("text-support");
});

test("a restart is recent only when its age is readable and under an hour", () => {
  expect(restartedRecently("13s")).toBe(true);
  expect(restartedRecently("59m")).toBe(true);
  expect(restartedRecently("60m")).toBe(false);
  expect(restartedRecently("1h")).toBe(false);
  expect(restartedRecently("2d1h")).toBe(false);
  expect(restartedRecently("<unknown>")).toBe(false);
  expect(restartedRecently(undefined)).toBe(false);
});
