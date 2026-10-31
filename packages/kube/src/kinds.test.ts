import { expect, test } from "vitest";
import RESOURCES from "../../protocol/src/mock/resources.json";
import { pluralTitle, sections } from "./kinds";

test.each([
  ["Pod", "pods", "Pods"],
  ["NetworkPolicy", "networkpolicies", "Network Policies"],
  ["Ingress", "ingresses", "Ingresses"],
  [
    "HorizontalPodAutoscaler",
    "horizontalpodautoscalers",
    "Horizontal Pod Autoscalers",
  ],
  ["Endpoints", "endpoints", "Endpoints"],
  ["PriorityClass", "priorityclasses", "Priority Classes"],
  ["FooBar", "widgets", "Foo Bars"],
])("%s with %s → %s", (kind, resource, title) => {
  expect(pluralTitle(kind, resource)).toBe(title);
});

test("recorded discovery fills Lens's sections, then custom groups", () => {
  const result = sections(RESOURCES);
  expect(result.map((section) => section.title)).toEqual([
    "Workloads",
    "Config",
    "Network",
    "Storage",
    "Access Control",
    "Cluster",
    "Custom Resources",
  ]);
  expect(result[result.length - 1]?.groups.map((group) => group.title)).toEqual(
    ["kwok.x-k8s.io"],
  );
  expect(result[0]?.items.map((item) => item.gvr.resource)).toEqual([
    "pods",
    "deployments",
    "daemonsets",
    "statefulsets",
    "replicasets",
    "jobs",
    "cronjobs",
  ]);
  const events = result
    .flatMap((section) => section.items)
    .filter((item) => item.gvr.resource === "events");
  expect(events.map((item) => item.gvr.group)).toEqual([""]);
});
