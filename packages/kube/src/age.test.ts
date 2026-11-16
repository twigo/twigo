import { expect, test } from "vitest";
import { ageRole, printedAge, printedAt, restartedRecently } from "./age";

const MINUTE = 60_000;

test("an age under ten minutes is in content and an older one in support", () => {
  expect(ageRole(10 * MINUTE - 1)).toBe("text-content");
  expect(ageRole(10 * MINUTE)).toBe("text-support");
});

test("a restart is recent while it is under an hour old", () => {
  expect(restartedRecently(13_000)).toBe(true);
  expect(restartedRecently(59 * MINUTE)).toBe(true);
  expect(restartedRecently(60 * MINUTE)).toBe(false);
  expect(restartedRecently(2 * 24 * 60 * MINUTE)).toBe(false);
});

test("a printed duration stands for the moment it was received less its age", () => {
  const received = "2026-11-16T12:00:00.000Z";
  const at = Date.parse(received);
  expect(printedAt(received, "5m")).toBe(at - 5 * MINUTE);
  expect(printedAt(received, "5m30s")).toBe(at - 5 * MINUTE - 30_000);
  expect(printedAt(received, "2d1h")).toBe(at - 49 * 60 * MINUTE);
  expect(printedAt(received, "<unknown>")).toBeUndefined();
  expect(printedAt(received, "soon")).toBeUndefined();
  expect(printedAt("not a time", "5m")).toBeUndefined();
  expect(printedAt("", "5m")).toBeUndefined();
});

test("a moment has an age unless it is unreadable or ahead of the clock by more than a second", () => {
  const now = Date.parse("2026-11-16T12:00:00.000Z");
  expect(printedAge(now - 5 * MINUTE, now)).toBe(5 * MINUTE);
  expect(printedAge(now + 500, now)).toBe(-500);
  expect(printedAge(now + 1000, now)).toBe(-1000);
  expect(printedAge(now + 1001, now)).toBeUndefined();
  expect(printedAge(undefined, now)).toBeUndefined();
});
