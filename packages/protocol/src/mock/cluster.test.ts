import { expect, test } from "vitest";
import { humanDuration, parseDuration } from "@twigo/utils";
import { Cluster, generatedAt } from "./cluster";
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
  const restarted = cluster.pods.filter((pod) => pod.restarts !== "0");
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

test("a pod is printed when it is made and again each time it changes, its age grown by the time since", () => {
  const start = Date.UTC(2026, 10, 3);
  const cluster = new Cluster("prod-eu", 1, start);
  const [pod] = cluster.pods;
  if (!pod) throw new Error("no pod");
  pod.restarts = "2 (5m ago)";
  expect(pod.received).toBe(start);
  const sameCount = new Set<number>();
  for (let step = 1; step <= 40; step++) {
    const now = start + step * 17 * 60_000;
    const before = { text: pod.restarts, received: pod.received };
    cluster.change(1, now);
    expect(pod.received).toBe(now);
    if (
      Number.parseInt(pod.restarts, 10) === Number.parseInt(before.text, 10)
    ) {
      const age = (ago(before.text) ?? NaN) + now - before.received;
      expect(pod.restarts).toBe(
        `${Number.parseInt(before.text, 10)} (${humanDuration(age)} ago)`,
      );
      sameCount.add(step);
    } else {
      expect(ago(pod.restarts)).toBeLessThanOrEqual(50_000);
    }
  }
  expect(sameCount.size).toBeGreaterThan(0);
  expect(sameCount.size).toBeLessThan(40);
});
