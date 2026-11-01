import { expect, test } from "vitest";
import { byHealth, healthValues } from "./health";
import { PODS } from "./kinds";

test("a health's values stay the same when their counts swap", () => {
  const values = (crash: number, error: number) =>
    healthValues(
      byHealth(
        PODS,
        "Status",
        [
          { value: "Running", count: 10 },
          { value: "CrashLoopBackOff", count: crash },
          { value: "Error", count: error },
        ].sort((a, b) => b.count - a.count),
      ).error,
    );
  expect(values(5, 3)).toEqual(["CrashLoopBackOff", "Error"]);
  expect(values(3, 5)).toEqual(values(5, 3));
});
