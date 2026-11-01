import { expect, test } from "vitest";
import { listUri, parseListUri } from "./uri";

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
