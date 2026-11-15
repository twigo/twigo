import { expect, test } from "vitest";
import { ageRole } from "./age";

const MINUTE = 60_000;

test("an age under ten minutes is in content and an older one in support", () => {
  expect(ageRole(10 * MINUTE - 1)).toBe("text-content");
  expect(ageRole(10 * MINUTE)).toBe("text-support");
});
