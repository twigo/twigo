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

test("a key holds until its answer says no, and each is asked once a namespace", async () => {
  const invoke = vi.fn(() => Promise.resolve([false, true]));
  const capabilities = new Capabilities({
    invoke,
  } as unknown as Pick<Backend, "invoke">);
  const keys = ["resource.capability.delete", "capability.create.jobs.batch"];
  expect(capabilities.values("qa", DEPLOYMENTS, "web", keys)).toEqual({
    "resource.capability.delete": true,
    "capability.create.jobs.batch": true,
  });
  capabilities.values("qa", DEPLOYMENTS, "web", keys);
  expect(invoke).toHaveBeenCalledOnce();
  expect(invoke).toHaveBeenCalledWith("access_review", {
    space: "qa",
    namespace: "web",
    checks: [
      {
        verb: "delete",
        group: "apps",
        resource: "deployments",
        subresource: null,
      },
      { verb: "create", group: "batch", resource: "jobs", subresource: null },
    ],
  });
  await Promise.resolve();
  expect(capabilities.values("qa", DEPLOYMENTS, "web", keys)).toEqual({
    "resource.capability.delete": false,
    "capability.create.jobs.batch": true,
  });
  capabilities.values("qa", DEPLOYMENTS, "shop", keys);
  expect(invoke).toHaveBeenCalledTimes(2);
});
