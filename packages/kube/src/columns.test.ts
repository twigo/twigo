import { expect, test } from "vitest";
import { alignsEnd, cellParts } from "./columns";
import { PODS } from "./kinds";
import { cellTone } from "./tones";

test("a pod's restarts split into the count and a grey remainder, and zero is quiet", () => {
  expect(cellParts(PODS, "Restarts", "3 (28m ago)")).toEqual({
    text: "3",
    rest: " (28m ago)",
    quiet: false,
  });
  expect(cellParts(PODS, "Restarts", "0")).toEqual({
    text: "0",
    rest: "",
    quiet: true,
  });
  expect(cellParts(PODS, "Name", "0")).toEqual({
    text: "0",
    rest: "",
    quiet: false,
  });
});

test("Ready aligns to the end as numbers do, and a ratio short of its total is pending", () => {
  expect(alignsEnd(PODS, { name: "Ready", kind: "string", priority: 0 })).toBe(
    true,
  );
  expect(alignsEnd(PODS, { name: "Status", kind: "string", priority: 0 })).toBe(
    false,
  );
  expect(cellTone(PODS, "Ready", "1/2")).toBe("warn");
  expect(cellTone(PODS, "Ready", "2/2")).toBeUndefined();
});
