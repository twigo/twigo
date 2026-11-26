import { expect, test } from "vitest";
import { HELM_RELEASES, type Column } from "@twigo/protocol";
import {
  byHealth,
  cellTone,
  columnRule,
  healthValues,
  IN_FLIGHT,
  problemColumn,
  problemOf,
  rowFinished,
  rowTone,
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
    secondary: true,
  });
  expect(columnRule(PODS, column("Name"))).toMatchObject({
    cell: "name",
    grow: true,
  });
  expect(columnRule(PODS, column("Namespace"))).toMatchObject({
    secondary: true,
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

test("CPU and Memory are numbers of their own kind: end-aligned, sorted largest first, read only while shown, and never flashed", () => {
  for (const [kind, cell] of [
    ["cpu", "cpu"],
    ["memory", "memory"],
  ] as const) {
    expect(columnRule(PODS, column("Any", kind))).toMatchObject({
      cell,
      align: "end",
      descendFirst: true,
      metric: true,
      flash: false,
    });
  }
  expect(columnRule(PODS, column("Restarts", "integer"))).toMatchObject({
    descendFirst: false,
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

test("a row's tone is the abnormal value of its resource's health column", () => {
  const columns = [column("Name"), column("Ready"), column("Status")];
  const row = (status: string) => ({
    id: "r",
    created: null,
    received: "2026-11-16T12:00:00.000Z",
    generated: null,
    cells: ["api", "0/1", status],
  });
  expect(rowTone(PODS, "Status", columns, row("ContainerCreating"))).toBe(
    "warn",
  );
  expect(rowTone(PODS, undefined, columns, row("Error"))).toBeUndefined();
});

test("a pod is finished by the words kubectl prints for one that ran to completion, and by no other status", () => {
  const columns = [column("Name"), column("Ready"), column("Status")];
  const row = (status: string) => ({
    id: "r",
    created: null,
    received: "2026-11-16T12:00:00.000Z",
    generated: null,
    cells: ["job-x7k2p", "0/1", status],
  });
  const finished = (statuses: readonly string[]) =>
    statuses.map((status) => [
      status,
      rowFinished(PODS, "Status", columns, row(status)),
    ]);
  const ended = ["Completed", "Succeeded", "ExitCode:0"];
  const other = [
    "Running",
    "Pending",
    "ContainerCreating",
    "PodInitializing",
    "NotReady",
    "Terminating",
    "Unknown",
    "Error",
    "OOMKilled",
    "ContainerCannotRun",
    "DeadlineExceeded",
    "Evicted",
    "ExitCode:1",
    "Signal:9",
    "CrashLoopBackOff",
    "ImagePullBackOff",
    "Init:Error",
    "Init:ExitCode:1",
    "Init:0/2",
  ];
  expect(finished(ended)).toEqual(ended.map((status) => [status, true]));
  expect(finished(other)).toEqual(other.map((status) => [status, false]));
  expect(rowFinished(PODS, undefined, columns, row("Completed"))).toBe(false);
});

test("only a pod's Status can finish a row: a Deployment's, a node's and a Job's values never do", () => {
  const nodes = { ...PODS, resource: "nodes" };
  const deployments = { group: "apps", version: "v1", resource: "deployments" };
  const jobs = { group: "batch", version: "v1", resource: "jobs" };
  const row = (...cells: string[]) => ({
    id: "r",
    created: null,
    received: "2026-11-16T12:00:00.000Z",
    generated: null,
    cells,
  });
  expect(
    rowFinished(nodes, "Status", [column("Status")], row("Completed")),
  ).toBe(false);
  expect(rowFinished(deployments, "Ready", [column("Ready")], row("0/1"))).toBe(
    false,
  );
  expect(
    rowFinished(
      jobs,
      "Status",
      [column("Status"), column("Completions")],
      row("Complete", "1/1"),
    ),
  ).toBe(false);
  expect(columnRule(deployments, column("Ready")).tone?.("0/1")).toBe("warn");
  expect(
    columnRule({ ...deployments, resource: "statefulsets" }, column("Ready"))
      .tone,
  ).toBeUndefined();
  expect(columnRule(jobs, column("Completions")).tone).toBeUndefined();
});

test("a column's cells are figures by their cell kind, or by a numeric column kind", () => {
  const figures = (name: string, kind: Column["kind"] = "string") =>
    columnRule(PODS, column(name, kind)).figures;
  expect(figures("Ready")).toBe(true);
  expect(figures("Restarts")).toBe(true);
  expect(figures("Age", "age")).toBe(true);
  expect(figures("CPU", "cpu")).toBe(true);
  expect(figures("Memory", "memory")).toBe(true);
  expect(figures("Priority", "integer")).toBe(true);
  expect(figures("Name")).toBe(false);
  expect(figures("Status")).toBe(false);
  expect(figures("Node")).toBe(false);
});

test("a hovered row's icons may lie over any column but a Name, a Ready or a Status, whatever their cells", () => {
  const statefulSets = {
    group: "apps",
    version: "v1",
    resource: "statefulsets",
  };
  const jobs = { group: "batch", version: "v1", resource: "jobs" };
  const coverable = (gvr: typeof PODS, name: string, kind?: Column["kind"]) =>
    columnRule(gvr, column(name, kind)).coverable;
  expect(coverable(PODS, "Name")).toBe(false);
  expect(coverable(PODS, "Ready")).toBe(false);
  expect(coverable(PODS, "Status")).toBe(false);
  expect(columnRule(statefulSets, column("Ready")).cell).toBe("text");
  expect(coverable(statefulSets, "Ready")).toBe(false);
  expect(coverable(jobs, "Status")).toBe(false);
  expect(coverable(PODS, "Restarts")).toBe(true);
  expect(coverable(PODS, "Age", "age")).toBe(true);
  expect(coverable(PODS, "CPU", "cpu")).toBe(true);
  expect(coverable(PODS, "Node")).toBe(true);
  expect(coverable(statefulSets, "Containers")).toBe(true);
});

test("a resource's Problem column is where its columns say, and a row has a problem only where that cell holds a code", () => {
  const columns = [column("Name"), column("Status"), column("Problem")];
  const row = (cell: string | null) => ({
    id: "r",
    created: null,
    received: "2026-11-16T12:00:00.000Z",
    generated: null,
    cells: ["alpha", "unreadable", cell],
  });
  const at = problemColumn(HELM_RELEASES, columns);
  expect(at).toBe(2);
  expect(problemOf(at, row("helm.truncated"))).toBe("helm.truncated");
  expect(problemOf(at, row(""))).toBeUndefined();
  expect(problemOf(at, row(null))).toBeUndefined();
  expect(problemColumn(PODS, columns)).toBe(-1);
  expect(problemOf(-1, row("helm.truncated"))).toBeUndefined();
});
