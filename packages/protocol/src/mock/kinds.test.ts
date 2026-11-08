import { expect, test } from "vitest";
import cronjobsList from "../../../../crates/twigo-cache/tests/fixtures/cronjobs-list.json";
import deploymentsList from "../../../../crates/twigo-cache/tests/fixtures/deployments-list.json";
import eventsList from "../../../../crates/twigo-cache/tests/fixtures/events-list.json";
import jobsList from "../../../../crates/twigo-cache/tests/fixtures/jobs-list.json";
import nodesList from "../../../../crates/twigo-cache/tests/fixtures/nodes-list.json";
import podsList from "../../../../crates/twigo-cache/tests/fixtures/pods-list.json";
import { Cluster } from "./cluster";
import { KINDS, type MockRow } from "./kinds";

const NOW = Date.UTC(2026, 10, 3);
const cluster = new Cluster("prod-eu", 5000, NOW);

function rows(kind: string): MockRow[] {
  const found = KINDS[kind];
  if (!found) throw new Error(`the mock serves no ${kind}`);
  return found.rows(cluster, false);
}

function column(kind: string, name: string): number {
  return KINDS[kind]?.columns.findIndex((c) => c.name === name) ?? -1;
}

test("each kind's columns are those kube-apiserver sent, by name and priority", () => {
  const recorded: Record<
    string,
    { columnDefinitions: { name: string; priority: number }[] }
  > = {
    "/v1/pods": podsList,
    "/v1/nodes": nodesList,
    "apps/v1/deployments": deploymentsList,
    "batch/v1/jobs": jobsList,
    "batch/v1/cronjobs": cronjobsList,
    "/v1/events": eventsList,
  };
  expect(Object.keys(KINDS).sort()).toEqual(Object.keys(recorded).sort());
  for (const [kind, list] of Object.entries(recorded)) {
    expect(
      KINDS[kind]?.columns.map(({ name, priority }) => ({ name, priority })),
      kind,
    ).toEqual(
      list.columnDefinitions.map(({ name, priority }) => ({ name, priority })),
    );
  }
});

test("the pods run on the nodes, some of which are not ready", () => {
  const nodes = rows("/v1/nodes");
  const names = new Set(nodes.map((node) => node.cells[0]));
  for (const pod of cluster.pods) expect(names, pod.id).toContain(pod.node);
  const status = column("/v1/nodes", "Status");
  expect(nodes.some((node) => node.cells[status] === "NotReady")).toBe(true);
  expect(nodes.some((node) => node.cells[status] === "Ready")).toBe(true);
  expect(new Cluster("dev", 0, NOW).nodes).toEqual([]);
});

test("a Deployment owns the pods its name heads, and counts those ready", () => {
  const deployments = rows("apps/v1/deployments");
  const at = (name: string) => column("apps/v1/deployments", name);
  expect(
    deployments.reduce(
      (sum, row) => sum + Number(row.cells[at("Up-to-date")]),
      0,
    ),
  ).toBe(cluster.pods.length);
  for (const row of deployments) {
    const name = String(row.cells[0]);
    const owned = cluster.pods.filter(
      (pod) =>
        pod.namespace === row.namespace &&
        pod.generateName === `${name}-${pod.templateHash}-`,
    );
    const ready = owned.filter(
      (pod) => pod.status === "Running" && pod.ready === pod.containers,
    ).length;
    expect(row.cells[at("Ready")], name).toBe(`${ready}/${owned.length}`);
    expect(row.cells[at("Available")], name).toBe(ready);
  }
});

test("a pod's failing state comes with the warning Kubernetes reports for it", () => {
  const events = rows("/v1/events");
  const at = (name: string) => column("/v1/events", name);
  const warned = new Set(
    events
      .filter((event) => event.cells[at("Type")] === "Warning")
      .map(
        (event) =>
          `${String(event.cells[at("Object")])} ${String(event.cells[at("Reason")])}`,
      ),
  );
  const expected: Record<string, string> = {
    CrashLoopBackOff: "BackOff",
    Error: "BackOff",
    ImagePullBackOff: "Failed",
    Pending: "FailedScheduling",
  };
  let checked = 0;
  for (const pod of cluster.pods) {
    const reason = expected[pod.status];
    if (!reason) continue;
    expect(warned, pod.name).toContain(`pod/${pod.name} ${reason}`);
    checked++;
  }
  expect(checked).toBeGreaterThan(100);
  for (const event of events)
    expect(event.cells[at("Last Seen")]).toMatch(/^\d/);
});
