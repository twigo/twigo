import { expect, test } from "vitest";
import { ageRole } from "./age";

const MINUTE = 60_000;

test("an age under ten minutes is in content and an older one in support", () => {
  expect(ageRole(0)).toBe("text-content");
  expect(ageRole(10 * MINUTE - 1)).toBe("text-content");
  expect(ageRole(10 * MINUTE)).toBe("text-support");
  expect(ageRole(2 * 24 * 60 * MINUTE)).toBe("text-support");
});
