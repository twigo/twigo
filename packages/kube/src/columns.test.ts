import { expect, test } from "vitest";
import type { Column } from "@twigo/protocol";
import {
  byHealth,
  cellTone,
  columnRule,
  healthValues,
  IN_FLIGHT,
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
    columnRule(
      { ...PODS, group: "apps", resource: "statefulsets" },
      column("Ready"),
    ),
  ).toMatchObject({ cell: "text", align: "start" });
  expect(columnRule(PODS, column("Restarts", "integer"))).toMatchObject({
    cell: "restarts",
    align: "end",
  });
});

test("CPU and Memory are numbers of their own kind: end-aligned, read only while shown, and never flashed", () => {
  for (const [kind, cell] of [
    ["cpu", "cpu"],
    ["memory", "memory"],
  ] as const) {
    expect(columnRule(PODS, column("Any", kind))).toMatchObject({
      cell,
      align: "end",
      metric: true,
      flash: false,
    });
  }
  expect(columnRule(PODS, column("Restarts", "integer"))).toMatchObject({
    metric: false,
    flash: true,
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

test("every status the pod printer writes has its tone, and a reason it does not know fails", () => {
  const healthy = ["Running", "Completed", "Succeeded", "ExitCode:0"];
  const waiting = [
    "Pending",
    "ContainerCreating",
    "PodInitializing",
    "SchedulingGated",
    "NotReady",
    "Terminating",
    "RestartingAllContainers",
    "Init:0/1",
    "Init:2/3",
    "Init:RestartingAllContainers",
  ];
  const failing = [
    "Failed",
    "Unknown",
    "ExitCode:1",
    "ExitCode:137",
    "Signal:9",
    "CrashLoopBackOff",
    "ErrImagePull",
    "ImagePullBackOff",
    "ImageInspectError",
    "ErrImageNeverPull",
    "InvalidImageName",
    "CreateContainerConfigError",
    "PreCreateHookError",
    "CreateContainerError",
    "PreStartHookError",
    "PostStartHookError",
    "RunContainerError",
    "Error",
    "OOMKilled",
    "ContainerCannotRun",
    "ContainerStatusUnknown",
    "DeadlineExceeded",
    "Evicted",
    "NodeLost",
    "Preempting",
    "Terminated",
    "NodeShutdown",
    "OutOfcpu",
    "OutOfmemory",
    "OutOfephemeral-storage",
    "OutOfpods",
    "OutOfnvidia.com/gpu",
    "NodeAffinity",
    "NodeName",
    "NodePorts",
    "TaintToleration",
    "UnexpectedAdmissionError",
    "UnknownReason",
    "InvalidNodeInfo",
    "PodOSNotSupported",
    "PodOSSelectorNodeLabelDoesNotMatch",
    "SysctlForbidden",
    "AppArmor",
    "SMTAlignmentError",
    "TopologyAffinityError",
    "SomeFutureReason",
    "Init:CrashLoopBackOff",
    "Init:ImagePullBackOff",
    "Init:ErrImagePull",
    "Init:CreateContainerConfigError",
    "Init:Error",
    "Init:OOMKilled",
    "Init:ContainerCannotRun",
    "Init:DeadlineExceeded",
    "Init:ExitCode:1",
    "Init:Signal:9",
  ];
  const tones = (statuses: readonly string[]) =>
    statuses.map((status) => [status, cellTone(PODS, "Status", status)]);
  expect(tones(healthy)).toEqual(healthy.map((status) => [status, undefined]));
  expect(tones(waiting)).toEqual(waiting.map((status) => [status, "warn"]));
  expect(tones(failing)).toEqual(failing.map((status) => [status, "error"]));
  expect(
    [...healthy, ...waiting, ...failing].filter((status) =>
      IN_FLIGHT.test(status),
    ),
  ).toEqual([
    "ContainerCreating",
    "PodInitializing",
    "Terminating",
    "RestartingAllContainers",
    "Init:0/1",
    "Init:2/3",
  ]);
});

test("a node's health is its Status, and a deployment's its Ready", () => {
  const nodes = { ...PODS, resource: "nodes" };
  const deployments = { group: "apps", version: "v1", resource: "deployments" };
  expect(statusColumn(nodes)).toBe("Status");
  expect(cellTone(nodes, "Status", "NotReady")).toBe("error");
  expect(cellTone(nodes, "Status", "NotReady,SchedulingDisabled")).toBe(
    "error",
  );
  expect(cellTone(nodes, "Status", "Unknown")).toBe("error");
  expect(cellTone(nodes, "Status", "Ready")).toBeUndefined();
  expect(cellTone(nodes, "Status", "Ready,SchedulingDisabled")).toBeUndefined();
  expect(statusColumn(deployments)).toBe("Ready");
  expect(cellTone(deployments, "Ready", "0/1")).toBe("warn");
  expect(cellTone(deployments, "Ready", "2/2")).toBeUndefined();
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
