import { expect, test } from "vitest";
import cronjobsList from "../../../../crates/twigo-cache/tests/fixtures/cronjobs-list.json";
import deploymentsList from "../../../../crates/twigo-cache/tests/fixtures/deployments-list.json";
import eventsList from "../../../../crates/twigo-cache/tests/fixtures/events-list.json";
import jobsList from "../../../../crates/twigo-cache/tests/fixtures/jobs-list.json";
import nodesList from "../../../../crates/twigo-cache/tests/fixtures/nodes-list.json";
import podsList from "../../../../crates/twigo-cache/tests/fixtures/pods-list.json";
import { humanDuration, parseDuration } from "@twigo/utils";
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
    "events.k8s.io/v1/events": eventsList,
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

test("a mock event and a CronJob stay as printed, with their stamp, while their times stay put", () => {
  const local = new Cluster("prod-eu", 500, NOW);
  const kinds: [string, string[]][] = [
    ["batch/v1/cronjobs", ["Last Schedule"]],
    ["/v1/events", ["Last Seen", "First Seen"]],
  ];
  const scheduled = new Map(
    local.cronJobs.map((cronJob) => [cronJob.id, cronJob.lastSchedule]),
  );
  for (const [kind, names] of kinds) {
    local.now = NOW;
    const read = () =>
      new Map(
        (KINDS[kind]?.rows(local, false) ?? []).map((row) => [
          row.id,
          {
            received: row.received,
            printed: names.map((name) => String(row.cells[column(kind, name)])),
          },
        ]),
      );
    const held = read();
    expect(held.size, kind).toBeGreaterThan(0);
    for (const [id, row] of held) {
      const moment = scheduled.get(id);
      const ago = parseDuration(row.printed[0] ?? "");
      if (moment !== undefined && ago !== undefined)
        expect(row.received - ago, id).toBeGreaterThanOrEqual(moment);
    }
    for (const seconds of [1, 3, 91, 3600, 90_000]) {
      local.now = NOW + seconds * 1000;
      const later = read();
      let compared = 0;
      for (const [id, row] of held) {
        const again = later.get(id);
        if (!again) continue;
        expect(again, `${id} at +${seconds}s`).toEqual(row);
        compared++;
      }
      expect(compared, `${kind} at +${seconds}s`).toBeGreaterThan(0);
    }
  }
  for (const job of KINDS["batch/v1/jobs"]?.rows(local, false) ?? [])
    expect(job.received, job.id).toBe(local.built);
});

test("a mock event's ages grow with the clock as the webview counts them back from its stamp", () => {
  const local = new Cluster("prod-eu", 500, NOW);
  const drawn = () =>
    new Map(
      (KINDS["/v1/events"]?.rows(local, false) ?? []).map((row) => [
        row.id,
        ["Last Seen", "First Seen"].map(
          (name) =>
            local.now -
            (row.received -
              (parseDuration(String(row.cells[column("/v1/events", name)])) ??
                NaN)),
        ),
      ]),
    );
  const before = drawn();
  local.now = NOW + 2 * 3_600_000;
  const after = drawn();
  let compared = 0;
  for (const [id, ages] of before) {
    const later = after.get(id);
    if (!later) continue;
    expect(
      later.map((age, at) => age - (ages[at] ?? NaN)),
      id,
    ).toEqual([2 * 3_600_000, 2 * 3_600_000]);
    compared++;
  }
  expect(compared).toBeGreaterThan(0);
});

test("a BackOff event repeats with its pod's restarts, whatever the age of the last", () => {
  const local = new Cluster("prod-eu", 500, NOW);
  const pod = local.pods.find((candidate) => candidate.status !== "Pending");
  if (!pod) throw new Error("no pod");
  Object.assign(pod, {
    status: "CrashLoopBackOff",
    restarts: "4 (3h ago)",
    lastRestart: NOW - 3 * 3_600_000,
  });
  const backOff = () => {
    const row = (KINDS["/v1/events"]?.rows(local, false) ?? []).find(
      (event) =>
        event.cells[column("/v1/events", "Object")] === `pod/${pod.name}` &&
        event.cells[column("/v1/events", "Reason")] === "BackOff",
    );
    if (!row) throw new Error("no BackOff");
    return {
      lastSeen: row.cells[column("/v1/events", "Last Seen")],
      firstSeen: row.cells[column("/v1/events", "First Seen")],
      count: row.cells[column("/v1/events", "Count")],
      received: row.received,
    };
  };
  const firstSeen = humanDuration(NOW - pod.created);
  expect(backOff()).toMatchObject({ lastSeen: "3h", firstSeen, count: 4 });
  local.now = NOW + 60_000;
  Object.assign(pod, { restarts: "5 (2s ago)", lastRestart: local.now - 2000 });
  expect(backOff()).toEqual({
    lastSeen: "2s",
    firstSeen: humanDuration(local.now - pod.created),
    count: 5,
    received: local.now,
  });
});
