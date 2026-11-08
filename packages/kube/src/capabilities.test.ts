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
    name: null,
  });
  expect(accessOf("resource.capability.patch/scale", DEPLOYMENTS)).toEqual({
    verb: "patch",
    group: "apps",
    resource: "deployments",
    subresource: "scale",
    name: null,
  });
  expect(accessOf("capability.create.jobs.batch", DEPLOYMENTS)).toEqual({
    verb: "create",
    group: "batch",
    resource: "jobs",
    subresource: null,
    name: null,
  });
  expect(accessOf("capability.create.pods/eviction", DEPLOYMENTS)).toEqual({
    verb: "create",
    group: "",
    resource: "pods",
    subresource: "eviction",
    name: null,
  });
  expect(
    accessOf("capability.get.ingresses.networking.k8s.io", DEPLOYMENTS),
  ).toEqual({
    verb: "get",
    group: "networking.k8s.io",
    resource: "ingresses",
    subresource: null,
    name: null,
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
  capabilities.ask("pods", "qa", PODS, { namespace: "shop" }, keys, BASIS);
  capabilities.ask(
    "deployments",
    "qa",
    DEPLOYMENTS,
    { namespace: "shop" },
    keys,
    BASIS,
  );
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

  capabilities.ask(
    "deployments",
    "qa",
    DEPLOYMENTS,
    { namespace: "shop" },
    keys,
    BASIS,
  );
  expect(invoke).toHaveBeenCalledTimes(2);
  capabilities.ask(
    "deployments",
    "qa",
    DEPLOYMENTS,
    { namespace: "web" },
    keys,
    BASIS,
  );
  expect(invoke).toHaveBeenCalledTimes(3);
  expect(capabilities.values("deployments", keys)).toEqual({
    "resource.capability.delete": true,
  });
  await settled();
  expect(capabilities.values("deployments", keys)).toEqual({
    "resource.capability.delete": false,
  });

  capabilities.closed("deployments");
  capabilities.ask(
    "deployments",
    "qa",
    DEPLOYMENTS,
    { namespace: "web" },
    keys,
    BASIS,
  );
  expect(invoke).toHaveBeenCalledTimes(4);
  capabilities.ask(
    "deployments",
    "qa",
    DEPLOYMENTS,
    { namespace: "web" },
    keys,
    {},
  );
  expect(invoke).toHaveBeenCalledTimes(5);
});

const PODS_GVR = { group: "", version: "v1", resource: "pods" };

function settled(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

test("the delete of marked rows holds only where every one of them may go", async () => {
  const invoke = vi.fn(
    (
      _command: string,
      request: { namespace: string | null; checks: { name: string | null }[] },
    ) =>
      Promise.resolve(
        request.checks.map(
          ({ name }) => request.namespace === "shop" && name !== "db",
        ),
      ),
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
    [
      { namespace: "shop", name: "web" },
      { namespace: "shop", name: "api" },
    ],
    BASIS,
  );
  await settled();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenLastCalledWith("access_review", {
    space: "qa",
    namespace: "shop",
    checks: ["web", "api"].map((name) => ({
      verb: "delete",
      group: "apps",
      resource: "deployments",
      subresource: null,
      name,
    })),
  });
  expect(capabilities.marked("deployments")).toBe(true);
  capabilities.askMarked(
    "deployments",
    "qa",
    DEPLOYMENTS,
    [
      { namespace: "shop", name: "web" },
      { namespace: "shop", name: "db" },
    ],
    BASIS,
  );
  await settled();
  expect(capabilities.marked("deployments")).toBe(false);
  capabilities.askMarked(
    "deployments",
    "qa",
    DEPLOYMENTS,
    [
      { namespace: "shop", name: "web" },
      { namespace: "web", name: "web" },
    ],
    BASIS,
  );
  await settled();
  expect(invoke).toHaveBeenCalledTimes(4);
  expect(capabilities.marked("deployments")).toBe(false);
  capabilities.closed("deployments");
  expect(capabilities.marked("deployments")).toBe(true);
});

test("a key names the list's object only for the list's own resource", async () => {
  const invoke = vi.fn(() => Promise.resolve([true, true]));
  const capabilities = new Capabilities({ invoke }, vi.fn());
  capabilities.ask(
    "deployments",
    "qa",
    DEPLOYMENTS,
    { namespace: "shop", name: "web" },
    ["resource.capability.patch/scale", "capability.create.jobs.batch"],
    {},
  );
  await settled();
  expect(invoke).toHaveBeenLastCalledWith("access_review", {
    space: "qa",
    namespace: "shop",
    checks: [
      {
        verb: "patch",
        group: "apps",
        resource: "deployments",
        subresource: "scale",
        name: "web",
      },
      {
        verb: "create",
        group: "batch",
        resource: "jobs",
        subresource: null,
        name: null,
      },
    ],
  });
});

test("a no for another object, or an answer that never came, holds nothing back", async () => {
  let answer: (answers: boolean[]) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const invoke = vi
    .fn()
    .mockResolvedValueOnce([false])
    .mockImplementationOnce(
      () =>
        new Promise<boolean[]>((resolve) => {
          answer = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<boolean[]>((_resolve, reject) => {
          fail = reject;
        }),
    );
  const report = vi.fn();
  const capabilities = new Capabilities({ invoke }, report);
  const keys = ["resource.capability.delete"];
  const at = (namespace: string) =>
    capabilities.ask("pods", "qa", PODS_GVR, { namespace }, keys, {});
  at("kube-system");
  await settled();
  expect(capabilities.values("pods", keys)["resource.capability.delete"]).toBe(
    false,
  );
  at("shop");
  expect(capabilities.values("pods", keys)["resource.capability.delete"]).toBe(
    true,
  );
  answer([false]);
  await settled();
  expect(capabilities.values("pods", keys)["resource.capability.delete"]).toBe(
    false,
  );
  at("web");
  fail(new Error("the cluster is away"));
  await settled();
  expect(report).toHaveBeenCalled();
  expect(capabilities.values("pods", keys)["resource.capability.delete"]).toBe(
    true,
  );
});

test("a new question that drops an answer tells the list at once", async () => {
  const invoke = vi
    .fn()
    .mockResolvedValueOnce([false])
    .mockReturnValue(new Promise(() => undefined));
  const capabilities = new Capabilities({ invoke }, vi.fn());
  const keys = ["resource.capability.delete"];
  const told = vi.fn();
  capabilities.changes.subscribe(told);
  const BASIS = {};
  capabilities.ask("pods", "qa", PODS_GVR, { namespace: "a" }, keys, BASIS);
  expect(told).not.toHaveBeenCalled();
  await settled();
  expect(told).toHaveBeenCalledOnce();
  capabilities.ask("pods", "qa", PODS_GVR, { namespace: "a" }, keys, {});
  expect(told).toHaveBeenCalledTimes(2);
  expect(capabilities.values("pods", keys)["resource.capability.delete"]).toBe(
    true,
  );
});
