import { expect, test } from "vitest";
import {
  execUri,
  listUri,
  objectUri,
  parseExecUri,
  parseListUri,
  parseObjectUri,
  parseTerminalUri,
  parseUntitledUri,
  terminalUri,
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

test.each([
  [
    { space: "prod-eu", namespace: "auth", pod: "api-0", container: "api" },
    "exec://prod-eu/auth/api-0/api",
  ],
  [
    {
      space: "dev+qa",
      namespace: "auth",
      pod: "api-0",
      container: "istio proxy",
      n: 2,
    },
    "exec://dev%2Bqa/auth/api-0/istio%20proxy?n=2",
  ],
  [
    {
      space: "prod-eu",
      namespace: "auth",
      pod: "api-0",
      container: "api",
      n: 13,
      attach: true,
    },
    "exec://prod-eu/auth/api-0/api?n=13&attach=1",
  ],
])("%o round-trips through %s", (input, uri) => {
  expect(execUri(input)).toBe(uri);
  expect(parseExecUri(uri)).toEqual(input);
});

test.each([
  "exec://prod-eu/auth/api-0",
  "exec://prod-eu/auth/api-0/api/extra",
  "exec://prod-eu//api-0/api",
  "logs://prod-eu/auth/api-0/api",
])("%s is no shell", (uri) => {
  expect(parseExecUri(uri)).toBeUndefined();
});

test("a shell's number is 2 or more, and anything else is the first", () => {
  const base = "exec://prod-eu/auth/api-0/api";
  expect(parseExecUri(`${base}?n=1`)?.n).toBeUndefined();
  expect(parseExecUri(`${base}?n=0`)?.n).toBeUndefined();
  expect(parseExecUri(`${base}?n=x`)?.n).toBeUndefined();
  expect(parseExecUri(`${base}?n=7`)?.n).toBe(7);
  expect(parseExecUri(`${base}?attach=0`)?.attach).toBeUndefined();
});

test.each([
  [{ space: "dev", n: 1 }, "terminal://dev/1"],
  [{ space: "dev+qa", n: 12 }, "terminal://dev%2Bqa/12"],
])("%o round-trips through %s", (input, uri) => {
  expect(terminalUri(input)).toBe(uri);
  expect(parseTerminalUri(uri)).toEqual(input);
});

test.each([
  "terminal://1",
  "terminal:///1",
  "terminal://dev/0",
  "terminal://dev/01",
  "terminal://dev/1/2",
  "terminal://dev/one",
  "exec://dev/1",
])("%s is no terminal", (uri) => {
  expect(parseTerminalUri(uri)).toBeUndefined();
});
