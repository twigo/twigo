import { expect, test } from "vitest";
import { humanDuration, parseDuration } from "@twigo/utils";
import {
  backOff,
  Cluster,
  CONTAINER_START,
  finishedAt,
  generatedAt,
  restartCount,
  type Pod,
} from "./cluster";
import { KINDS } from "./kinds";

test("a Deployment's pod is generated from its template hash", () => {
  expect(
    generatedAt("api-7f9c8d6b5-x2kq9", "api-7f9c8d6b5-", {
      app: "api",
      "pod-template-hash": "7f9c8d6b5",
    }),
  ).toBe(4);
});

test("a DaemonSet's pod is generated after its generateName", () => {
  expect(
    generatedAt("agent-x7k2p", "agent-", {
      "controller-revision-hash": "6b8c7d9f4",
    }),
  ).toBe(6);
});

test("a StatefulSet's pod has no generated part", () => {
  expect(
    generatedAt("db-0", "db-", {
      "statefulset.kubernetes.io/pod-name": "db-0",
    }),
  ).toBeNull();
});

test("a StatefulSet's pod with a five-digit ordinal has no generated part", () => {
  expect(
    generatedAt("db-24567", "db-", {
      "statefulset.kubernetes.io/pod-name": "db-24567",
    }),
  ).toBeNull();
});

test("a long generateName is cut to what the API server keeps", () => {
  const base = `${"a".repeat(59)}-`;
  expect(generatedAt(`${base.slice(0, 58)}x2kq9`, base, {})).toBe(58);
  const owner = "w".repeat(50);
  const hash = { "pod-template-hash": "7f9c8d6b5" };
  expect(
    generatedAt(`${owner}-7f9c8d6x2kq9`, `${owner}-7f9c8d6b5-`, hash),
  ).toBe(51);
  const long = "w".repeat(58);
  expect(generatedAt(`${long}x2kq9`, `${long}-7f9c8d6b5-`, hash)).toBe(58);
  const accented = `${"é".repeat(30)}-`;
  expect(generatedAt(`${"é".repeat(29)}x2kq9`, accented, {})).toBe(29);
  expect(generatedAt(`a${"é".repeat(29)}x2kq9`, `a${accented}`, {})).toBeNull();
});

test("a name that does not start with its generateName has none", () => {
  expect(generatedAt("web-x2kq9", "api-", {})).toBeNull();
  const base = `${"a".repeat(59)}-`;
  expect(generatedAt(`${base}x2kq9`, base, {})).toBeNull();
  expect(generatedAt("web-x2kq9", null, {})).toBeNull();
  expect(
    generatedAt("api-x2kq9", "api-", { "pod-template-hash": "7f9c8d6b5" }),
  ).toBe(4);
});

test("the start counts UTF-16 units", () => {
  expect(generatedAt("rôle-x2kq9", "rôle-", {})).toBe(5);
});

test("the mock's pods read as a Deployment's", () => {
  const cluster = new Cluster("kind-local", 40, Date.UTC(2026, 10, 3));
  const rows = new Map(
    KINDS["/v1/pods"]?.rows(cluster, true).map((row) => [row.id, row]),
  );
  for (const pod of cluster.pods) {
    const row = rows.get(pod.id);
    if (!row) throw new Error(`no row for ${pod.id}`);
    expect(row.generated, pod.name).not.toBeNull();
    expect(pod.name.slice(row.generated ?? 0)).toBe(
      pod.name.slice(pod.generateName.length - pod.templateHash.length - 1),
    );
    expect(pod.name.slice(row.generated ?? 0)).toMatch(
      /^[0-9a-z]+-[0-9a-z]{5}$/,
    );
  }
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (restarts: string) =>
  parseDuration(/\((.+) ago\)$/.exec(restarts)?.[1] ?? "");

test("a running pod's last restart is minutes, hours or days old, any other pod's minutes", () => {
  const cluster = new Cluster("prod-eu", 4000, Date.UTC(2026, 10, 3));
  const restarted = cluster.pods.filter(
    (pod) => pod.restarts !== "0" && pod.status !== "Completed",
  );
  const [running, other] = [
    restarted.filter((pod) => pod.status === "Running"),
    restarted.filter((pod) => pod.status !== "Running"),
  ].map((pods) => pods.map((pod) => ago(pod.restarts) ?? NaN));
  expect(running?.some((age) => age < HOUR)).toBe(true);
  expect(running?.some((age) => age >= HOUR && age < DAY)).toBe(true);
  expect(running?.some((age) => age >= DAY)).toBe(true);
  expect(other?.length).toBeGreaterThan(0);
  expect(other?.every((age) => age <= HOUR - 60_000)).toBe(true);
});

test("a pod that finished restarted before it did, and one that never started has not restarted", () => {
  const cluster = new Cluster("prod-eu", 4000, Date.UTC(2026, 10, 3));
  const finished = cluster.pods.filter(
    (pod) => pod.status === "Completed" && pod.restarts !== "0",
  );
  expect(finished.length).toBeGreaterThan(0);
  for (const pod of finished) {
    expect(pod.lastRestart, pod.name).toBeGreaterThanOrEqual(pod.created);
    expect(pod.lastRestart, pod.name).toBeLessThan(finishedAt(pod));
  }
  const waiting = cluster.pods.filter(
    (pod) => pod.status === "Pending" || pod.status === "ContainerCreating",
  );
  expect(waiting.length).toBeGreaterThan(0);
  expect(waiting.map((pod) => [pod.restarts, pod.lastRestart])).toEqual(
    waiting.map(() => ["0", null]),
  );
});

function leastTaken(restarts: number): number {
  let taken = CONTAINER_START;
  for (let exit = 1; exit < restarts; exit++) taken += backOff(exit);
  return taken;
}

function holdsWhatTheGeneratorHolds(cluster: Cluster) {
  const now = cluster.now;
  const states = new Set<string>();
  for (const pod of cluster.pods) {
    const restarts = restartCount(pod);
    const as = `${pod.status} ${pod.name}`;
    states.add(`${pod.status}${pod.containers > 1 ? " with sidecars" : ""}`);
    if (pod.lastRestart !== null) {
      expect(pod.lastRestart, as).toBeGreaterThanOrEqual(
        pod.created + leastTaken(restarts),
      );
      expect(pod.lastRestart, as).toBeLessThanOrEqual(now);
    }
    switch (pod.status) {
      case "CrashLoopBackOff":
        expect(restarts, as).toBeGreaterThan(0);
        expect(now - (pod.lastRestart ?? NaN), as).toBeLessThan(
          backOff(restarts),
        );
        expect(pod.ready, as).toBe(pod.containers - 1);
        break;
      case "Pending":
      case "ContainerCreating":
        expect([pod.restarts, pod.lastRestart, pod.ready], as).toEqual([
          "0",
          null,
          0,
        ]);
        break;
      case "Completed":
        expect(pod.lastRestart ?? 0, as).toBeLessThan(finishedAt(pod));
        expect(pod.ready, as).toBe(0);
        break;
      case "Error":
      case "ImagePullBackOff":
        expect(pod.ready, as).toBe(pod.containers - 1);
        break;
      default:
        expect(pod.ready, as).toBeGreaterThanOrEqual(pod.containers - 1);
        expect(pod.ready, as).toBeLessThanOrEqual(pod.containers);
    }
  }
  return states;
}

test("the mock's pods are made as the kubelet leaves them: a crash loop waits within its back-off, and no restart comes before the pod could have had it", () => {
  const states = holdsWhatTheGeneratorHolds(
    new Cluster("prod-eu", 5000, Date.UTC(2026, 10, 3)),
  );
  expect([...states]).toEqual(
    expect.arrayContaining([
      "CrashLoopBackOff",
      "CrashLoopBackOff with sidecars",
      "Pending",
      "ContainerCreating",
      "Completed",
      "Error",
      "ImagePullBackOff with sidecars",
    ]),
  );
});

test("the churn keeps what the generator holds, through ten simulated minutes", () => {
  const start = Date.UTC(2026, 10, 3);
  for (const [change, rows] of [
    [(cluster: Cluster, at: number) => cluster.churn(10, [], at), 5000],
    [(cluster: Cluster, at: number) => cluster.change(100, at), 5000],
  ] as const) {
    const cluster = new Cluster("prod-eu", rows, start);
    for (let second = 1; second <= 600; second++) {
      change(cluster, start + second * 1000);
    }
    const states = holdsWhatTheGeneratorHolds(cluster);
    expect([...states]).toEqual(
      expect.arrayContaining([
        "CrashLoopBackOff",
        "CrashLoopBackOff with sidecars",
        "Pending",
        "ContainerCreating",
        "Completed",
        "Error with sidecars",
      ]),
    );
  }
});

test("a crash loop starts again at each end of its back-off, however far the clock jumps", () => {
  const start = Date.UTC(2026, 10, 3);
  const cluster = new Cluster("prod-eu", 1000, start);
  const loops = cluster.pods
    .filter((pod) => pod.status === "CrashLoopBackOff")
    .map((pod) => ({
      pod,
      restarts: restartCount(pod),
      last: pod.lastRestart ?? NaN,
    }));
  expect(loops.length).toBeGreaterThan(0);
  const now = start + 400 * DAY;
  cluster.change(cluster.pods.length, now);
  expect([...holdsWhatTheGeneratorHolds(cluster)]).toContain(
    "CrashLoopBackOff",
  );
  for (const { pod, restarts, last } of loops) {
    if (pod.status !== "CrashLoopBackOff") continue;
    let [count, at] = [restarts, last];
    while (at + backOff(count) <= now) at += backOff(count++);
    expect([restartCount(pod), pod.lastRestart]).toEqual([count, at]);
  }
});

test("the churn does not restart or crash a pod before its first container could have exited", () => {
  const start = Date.UTC(2026, 10, 3);
  const cluster = new Cluster("prod-eu", 400, start);
  for (const pod of cluster.pods) {
    Object.assign(pod, {
      status: "Running",
      ready: pod.containers,
      restarts: "0",
      lastRestart: null,
      created: start - CONTAINER_START / 2,
    });
  }
  cluster.change(cluster.pods.length, start);
  expect(
    cluster.pods.map(({ status, restarts, lastRestart }) => [
      status,
      restarts,
      lastRestart,
    ]),
  ).toEqual(cluster.pods.map(() => ["Running", "0", null]));
  cluster.change(cluster.pods.length, start + CONTAINER_START);
  expect(cluster.pods.some(({ restarts }) => restarts !== "0")).toBe(true);
});

test("a pod's Restarts counts from the moment of its last restart, so its age grows across prints", () => {
  const start = Date.UTC(2026, 10, 3);
  const cluster = new Cluster("prod-eu", 400, start);
  const known = new Map<Pod, { count: number; at: number }>();
  for (const pod of cluster.pods) {
    const at = start - 10 * DAY - 23 * HOUR;
    Object.assign(pod, { restarts: "2 (10d ago)", lastRestart: at });
    pod.received = start;
    known.set(pod, { count: 2, at });
  }
  let grown = 0;
  let kept = 0;
  for (let step = 1; step <= 40; step++) {
    const now = start + step * 17 * 60_000;
    const before = new Map(
      cluster.pods.map((pod) => [pod, { ...pod }] as const),
    );
    cluster.change(cluster.pods.length, now);
    for (const pod of cluster.pods) {
      const printed = before.get(pod);
      const last = known.get(pod);
      if (!printed || !last) continue;
      const count = Number.parseInt(pod.restarts, 10);
      if (count > last.count) {
        known.set(pod, { count, at: now - (ago(pod.restarts) ?? NaN) });
      } else {
        expect(pod.restarts).toBe(
          `${count} (${humanDuration(now - last.at)} ago)`,
        );
        if (now - last.at >= 11 * DAY) grown++;
      }
      expect(pod.received).toBe(
        pod.restarts === printed.restarts ? printed.received : now,
      );
      expect(pod.received - (ago(pod.restarts) ?? NaN)).toBeGreaterThanOrEqual(
        known.get(pod)?.at ?? NaN,
      );
      if (pod.restarts === printed.restarts) kept++;
    }
  }
  expect(grown).toBeGreaterThan(0);
  expect(kept).toBeGreaterThan(0);
});

const MOMENT = Date.UTC(2026, 10, 3);

function printing() {
  const cluster = new Cluster("prod-eu", 0, MOMENT);
  return (now: number, last: number) => {
    cluster.now = now;
    return cluster.printed("prod-eu/default/web.1", [last, MOMENT - 2 * DAY]);
  };
}

test("a row whose moment moves but prints the same ages keeps the stamp it held", () => {
  const print = printing();
  expect(print(MOMENT, MOMENT - 5 * 60_000)).toMatchObject({
    texts: ["5m", "2d"],
    at: MOMENT,
  });
  expect(print(MOMENT + 1000, MOMENT + 1000 - 5 * 60_000)).toMatchObject({
    texts: ["5m", "2d"],
    at: MOMENT,
  });
});

test("a row whose moment moves and prints other ages takes the clock as its stamp", () => {
  const print = printing();
  print(MOMENT, MOMENT - 5 * 60_000);
  expect(print(MOMENT + 1000, MOMENT + 1000 - 100_000)).toMatchObject({
    texts: ["100s", "2d"],
    at: MOMENT + 1000,
  });
});
