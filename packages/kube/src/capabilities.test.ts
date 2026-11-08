import { expect, test, vi } from "vitest";
import type { Backend } from "@twigo/protocol";
import { accessOf, Capabilities } from "./capabilities";

const DEPLOYMENTS = { group: "apps", version: "v1", resource: "deployments" };

test("a key names the list's own resource or one by kubectl's name", () => {
  expect(accessOf("resource.capability.delete", DEPLOYMENTS)).toEqual({
    verb: "delete",
    group: "apps",
    resource: "deployments",
    subresource: null,
  });
  expect(accessOf("resource.capability.patch/scale", DEPLOYMENTS)).toEqual({
    verb: "patch",
    group: "apps",
    resource: "deployments",
    subresource: "scale",
  });
  expect(accessOf("capability.create.jobs.batch", DEPLOYMENTS)).toEqual({
    verb: "create",
    group: "batch",
    resource: "jobs",
    subresource: null,
  });
  expect(accessOf("capability.create.pods/eviction", DEPLOYMENTS)).toEqual({
    verb: "create",
    group: "",
    resource: "pods",
    subresource: "eviction",
  });
  expect(
    accessOf("capability.get.ingresses.networking.k8s.io", DEPLOYMENTS),
  ).toEqual({
    verb: "get",
    group: "networking.k8s.io",
    resource: "ingresses",
    subresource: null,
  });
  expect(accessOf("capability.delete", DEPLOYMENTS)).toBeUndefined();
  expect(accessOf("resource.selected", DEPLOYMENTS)).toBeUndefined();
});

test("each list asks for its own resource, and again when its selection moves", async () => {
  const invoke = vi.fn(
    (
      _command: string,
      request: { namespace: string | null; checks: { resource: string }[] },
    ) =>
      Promise.resolve(
        request.checks.map(
          ({ resource }) => resource !== "pods" && request.namespace === "shop",
        ),
      ),
  );
  const capabilities = new Capabilities(
    { invoke } as unknown as Pick<Backend, "invoke">,
    vi.fn(),
  );
  const keys = ["resource.capability.delete"];
  const PODS = { group: "", version: "v1", resource: "pods" };
  const BASIS = {};
  capabilities.ask("pods", "qa", PODS, "shop", keys, BASIS);
  capabilities.ask("deployments", "qa", DEPLOYMENTS, "shop", keys, BASIS);
  expect(capabilities.values("pods", keys)).toEqual({
    "resource.capability.delete": true,
  });
  await settled();
  expect(capabilities.values("pods", keys)).toEqual({
    "resource.capability.delete": false,
  });
  expect(capabilities.values("deployments", keys)).toEqual({
    "resource.capability.delete": true,
  });
  expect(invoke).toHaveBeenCalledTimes(2);

  capabilities.ask("deployments", "qa", DEPLOYMENTS, "shop", keys, BASIS);
  expect(invoke).toHaveBeenCalledTimes(2);
  capabilities.ask("deployments", "qa", DEPLOYMENTS, "web", keys, BASIS);
  expect(invoke).toHaveBeenCalledTimes(3);
  expect(capabilities.values("deployments", keys)).toEqual({
    "resource.capability.delete": true,
  });
  await settled();
  expect(capabilities.values("deployments", keys)).toEqual({
    "resource.capability.delete": false,
  });

  capabilities.closed("deployments");
  capabilities.ask("deployments", "qa", DEPLOYMENTS, "web", keys, BASIS);
  expect(invoke).toHaveBeenCalledTimes(4);
  capabilities.ask("deployments", "qa", DEPLOYMENTS, "web", keys, {});
  expect(invoke).toHaveBeenCalledTimes(5);
});

function settled(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

test("the delete of marked rows holds only where every namespace they are in allows it", async () => {
  const invoke = vi.fn(
    (_command: string, request: { namespace: string | null }) =>
      Promise.resolve([request.namespace === "shop"]),
  );
  const capabilities = new Capabilities(
    { invoke } as unknown as Pick<Backend, "invoke">,
    vi.fn(),
  );
  const BASIS = {};
  expect(capabilities.marked("deployments")).toBe(true);
  capabilities.askMarked(
    "deployments",
    "qa",
    DEPLOYMENTS,
    ["shop", "shop"],
    BASIS,
  );
  await settled();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenLastCalledWith("access_review", {
    space: "qa",
    namespace: "shop",
    checks: [
      {
        verb: "delete",
        group: "apps",
        resource: "deployments",
        subresource: null,
      },
    ],
  });
  expect(capabilities.marked("deployments")).toBe(true);
  capabilities.askMarked(
    "deployments",
    "qa",
    DEPLOYMENTS,
    ["shop", "web"],
    BASIS,
  );
  await settled();
  expect(invoke).toHaveBeenCalledTimes(3);
  expect(capabilities.marked("deployments")).toBe(false);
  capabilities.closed("deployments");
  expect(capabilities.marked("deployments")).toBe(true);
});
