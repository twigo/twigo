import { expect, test } from "vitest";
import { splitKey, valueFold } from "./labels";

test.each([
  ["app.kubernetes.io/name", "app.kubernetes.io/", "name"],
  [
    "kubectl.kubernetes.io/last-applied-configuration",
    "kubectl.kubernetes.io/",
    "last-applied-configuration",
  ],
  ["app", "", "app"],
  ["pod-template-hash", "", "pod-template-hash"],
])("%s splits into %j and %j", (key, prefix, name) => {
  expect(splitKey(key)).toEqual({ prefix, name });
});

test("a value of more than two lines folds, and kubectl's copy of the object folds from the start", () => {
  const line = "x".repeat(80);
  expect(valueFold("app", "api")).toBe("whole");
  expect(valueFold("note", `${line}\n${line}`)).toBe("whole");
  expect(valueFold("note", `${line}\n${line}\n${line}`)).toBe("clamped");
  expect(valueFold("note", "x".repeat(161))).toBe("clamped");
  expect(
    valueFold("kubectl.kubernetes.io/last-applied-configuration", "{}"),
  ).toBe("hidden");
});
