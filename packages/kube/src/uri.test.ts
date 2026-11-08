import { expect, test } from "vitest";
import {
  listUri,
  objectUri,
  parseListUri,
  parseObjectUri,
  parseUntitledUri,
  untitledUri,
} from "./uri";

const PODS = { group: "", version: "v1", resource: "pods" };
const DEPLOYMENTS = { group: "apps", version: "v1", resource: "deployments" };

test.each([
  [{ space: "prod-eu", gvr: PODS }, "k8s-list://prod-eu/v1/pods"],
  [
    { space: "dev+qa", gvr: DEPLOYMENTS },
    "k8s-list://dev%2Bqa/apps/v1/deployments",
  ],
  [
    {
      space: "prod-eu",
      gvr: PODS,
      namespaces: ["payments", "auth"],
      text: "api",
      labels: "app=web",
    },
    "k8s-list://prod-eu/v1/pods?ns=payments%2Cauth&q=api&l=app%3Dweb",
  ],
])("%o round-trips through %s", (input, uri) => {
  expect(listUri(input)).toBe(uri);
  expect(parseListUri(uri)).toEqual(input);
});

test("a core-group resource keeps an empty group", () => {
  expect(parseListUri("k8s-list://prod-eu/v1/pods")?.gvr).toEqual(PODS);
});

test.each([
  "k8s://prod-eu/v1/pods",
  "k8s-list://prod-eu/pods",
  "k8s-list://prod-eu/a/b/c/d",
])("%s is no list", (uri) => {
  expect(parseListUri(uri)).toBeUndefined();
});

const STAGES = {
  group: "kwok.x-k8s.io",
  version: "v1alpha1",
  resource: "stages",
};

test.each([
  [
    { space: "prod-eu", gvr: PODS, namespace: "payments", name: "api-0" },
    "k8s://prod-eu//v1/pods/payments/api-0",
  ],
  [
    { space: "prod-eu", gvr: STAGES, name: "pod-ready" },
    "k8s://prod-eu/kwok.x-k8s.io/v1alpha1/stages/pod-ready",
  ],
  [
    { space: "prod-eu", gvr: { ...PODS, resource: "nodes" }, name: "node-1" },
    "k8s://prod-eu//v1/nodes/node-1",
  ],
])("the object %o round-trips through %s", (input, uri) => {
  expect(objectUri(input)).toBe(uri);
  expect(parseObjectUri(uri)).toEqual(input);
});

test("a core object in a namespace and a grouped cluster-scoped one differ", () => {
  expect(parseObjectUri("k8s://s//v1/pods/payments/api-0")?.namespace).toBe(
    "payments",
  );
  expect(
    parseObjectUri("k8s://s/kwok.x-k8s.io/v1alpha1/stages/pod-ready")
      ?.namespace,
  ).toBeUndefined();
});

test.each([
  [{ space: "dev", n: 1 }, "untitled://dev/manifest-1"],
  [{ space: "dev+qa", n: 12 }, "untitled://dev%2Bqa/manifest-12"],
])("%o round-trips through %s", (input, uri) => {
  expect(untitledUri(input)).toBe(uri);
  expect(parseUntitledUri(uri)).toEqual(input);
});

test.each([
  "untitled://manifest-1",
  "untitled:///manifest-1",
  "untitled://dev/manifest-0",
  "untitled://dev/manifest-1/2",
  "untitled://dev/other-1",
  "k8s://dev/manifest-1",
])("%s is no new manifest", (uri) => {
  expect(parseUntitledUri(uri)).toBeUndefined();
});
