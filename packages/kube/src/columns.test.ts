import { expect, test } from "vitest";
import type { Column } from "@twigo/protocol";
import {
  byHealth,
  cellTone,
  columnRule,
  healthValues,
  statusColumn,
  worstHealth,
} from "./columns";
import { PODS } from "./kinds";

const column = (name: string, kind: Column["kind"] = "string"): Column => ({
  name,
  kind,
  priority: 0,
});

test("a column's rule comes from its kind, then its name, then its resource", () => {
  expect(columnRule(PODS, column("Age", "age"))).toMatchObject({
    cell: "age",
    align: "end",
    quiet: true,
  });
  expect(columnRule(PODS, column("Name"))).toMatchObject({
    cell: "name",
    grow: true,
  });
  expect(columnRule(PODS, column("Namespace"))).toMatchObject({
    quiet: true,
    groups: true,
  });
  expect(columnRule(PODS, column("Ready"))).toMatchObject({
    cell: "ratio",
    align: "end",
  });
  expect(
    columnRule({ ...PODS, resource: "deployments" }, column("Ready")),
  ).toMatchObject({ cell: "text", align: "start" });
  expect(columnRule(PODS, column("Restarts", "integer"))).toMatchObject({
    cell: "restarts",
    align: "end",
  });
});

test("a pod's status column is Status, and its abnormal values have tones", () => {
  expect(statusColumn(PODS)).toBe("Status");
  expect(statusColumn({ ...PODS, resource: "services" })).toBeUndefined();
  expect(cellTone(PODS, "Status", "CrashLoopBackOff")).toBe("error");
  expect(cellTone(PODS, "Status", "ContainerCreating")).toBe("warn");
  expect(cellTone(PODS, "Status", "Running")).toBeUndefined();
  expect(cellTone(PODS, "Ready", "1/2")).toBe("warn");
  expect(cellTone(PODS, "Ready", "2/2")).toBeUndefined();
});

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

test("the worst health of counts is what a group or a list sums up to", () => {
  const worst = (values: readonly string[]) =>
    worstHealth(
      byHealth(
        PODS,
        "Status",
        values.map((value) => ({ value, count: 1 })),
      ),
    );
  expect(worst(["Running"])).toBe("ok");
  expect(worst(["Running", "Pending"])).toBe("warn");
  expect(worst(["Pending", "Error"])).toBe("error");
});
