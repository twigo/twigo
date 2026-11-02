import { expect, test } from "vitest";
import { Cluster, generatedAt, podRow } from "./cluster";

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

test("a name that does not start with its generateName has none", () => {
  expect(generatedAt("web-x2kq9", "api-", {})).toBeNull();
  const base = `${"a".repeat(59)}-`;
  expect(generatedAt(`${base.slice(0, 58)}x2kq9`, base, {})).toBeNull();
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
  for (const pod of cluster.pods) {
    const row = podRow(pod, true);
    expect(row.generated, pod.name).not.toBeNull();
    expect(pod.name.slice(row.generated ?? 0)).toBe(
      pod.name.slice(pod.generateName.length - pod.templateHash.length - 1),
    );
    expect(pod.name.slice(row.generated ?? 0)).toMatch(
      /^[0-9a-z]+-[0-9a-z]{5}$/,
    );
  }
});
