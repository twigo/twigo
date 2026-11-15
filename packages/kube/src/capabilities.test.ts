import { expect, test, vi } from "vitest";
import type { Backend } from "@twigo/protocol";
import { accessOf, Capabilities, REFUSED_MS } from "./capabilities";

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

test("a no is asked again after 30 s, as Rust asks RBAC again, until the list closes", async () => {
  vi.useFakeTimers();
  try {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce([false])
      .mockResolvedValueOnce([true])
      .mockResolvedValueOnce([false])
      .mockResolvedValue([false]);
    const capabilities = new Capabilities({ invoke }, vi.fn());
    const keys = ["resource.capability.delete"];
    const delete_ = () =>
      capabilities.values("pods", keys)["resource.capability.delete"];
    capabilities.ask("pods", "qa", PODS_GVR, { namespace: "a" }, keys, {});
    await vi.advanceTimersByTimeAsync(0);
    expect(delete_()).toBe(false);
    await vi.advanceTimersByTimeAsync(REFUSED_MS - 1);
    expect(invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(delete_()).toBe(true);
    await vi.advanceTimersByTimeAsync(REFUSED_MS * 2);
    expect(invoke).toHaveBeenCalledTimes(2);

    capabilities.ask("pods", "qa", PODS_GVR, { namespace: "b" }, keys, {});
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(3);
    capabilities.closed("pods");
    await vi.advanceTimersByTimeAsync(REFUSED_MS * 2);
    expect(invoke).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

test("asking the same again starts no second round of asks", async () => {
  vi.useFakeTimers();
  try {
    const invoke = vi.fn().mockResolvedValue([false]);
    const capabilities = new Capabilities({ invoke }, vi.fn());
    const keys = ["resource.capability.delete"];
    const at = (namespace: string) => {
      capabilities.ask("pods", "qa", PODS_GVR, { namespace }, keys, {});
    };
    const BASIS = {};
    const same = () => {
      capabilities.ask("pods", "qa", PODS_GVR, { namespace: "a" }, keys, BASIS);
    };
    same();
    await vi.advanceTimersByTimeAsync(0);
    at("b");
    await vi.advanceTimersByTimeAsync(0);
    same();
    await vi.advanceTimersByTimeAsync(0);
    capabilities.closed("pods");
    same();
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(REFUSED_MS);
    expect(invoke).toHaveBeenCalledTimes(5);
  } finally {
    vi.useRealTimers();
  }
});

test("a hovered row reads its own answers once they come, until then its namespace's last for another resource as a whole, never another object's, and a new basis forgets them", async () => {
  const refused = new Set(["web"]);
  const invoke = vi.fn(
    (
      _command: string,
      request: {
        namespace: string | null;
        checks: { resource: string; name: string | null }[];
      },
    ) =>
      Promise.resolve(
        request.checks.map(({ resource, name }) =>
          resource === "jobs"
            ? request.namespace !== "shop"
            : !refused.has(name ?? ""),
        ),
      ),
  );
  const capabilities = new Capabilities(
    { invoke } as unknown as Pick<Backend, "invoke">,
    vi.fn(),
  );
  const DELETE = "resource.capability.delete";
  const JOBS = "capability.create.jobs.batch";
  const keys = [DELETE, JOBS];
  const BASIS = {};
  const hovered = (namespace: string, name: string) =>
    capabilities.hovered("pods", { namespace, name }, keys);
  const hover = (name: string, basis: unknown) => {
    capabilities.askHovered(
      "pods",
      "qa",
      PODS_GVR,
      { namespace: "shop", name },
      keys,
      basis,
    );
  };
  capabilities.ask(
    "pods",
    "qa",
    PODS_GVR,
    { namespace: "shop", name: "web" },
    keys,
    BASIS,
  );
  expect(hovered("shop", "cart")).toEqual({ [DELETE]: true, [JOBS]: true });
  await settled();
  expect(hovered("shop", "web")).toEqual({ [DELETE]: false, [JOBS]: false });
  expect(hovered("shop", "cart")).toEqual({ [DELETE]: true, [JOBS]: false });
  expect(hovered("edge", "cart")).toEqual({ [DELETE]: true, [JOBS]: true });

  refused.add("api");
  hover("api", BASIS);
  expect(hovered("shop", "api")).toEqual({ [DELETE]: true, [JOBS]: false });
  await settled();
  expect(invoke).toHaveBeenLastCalledWith(
    "access_review",
    expect.objectContaining({
      namespace: "shop",
      checks: [
        expect.objectContaining({ verb: "delete", name: "api" }),
        expect.objectContaining({ verb: "create", resource: "jobs" }),
      ],
    }),
  );
  expect(hovered("shop", "api")).toEqual({ [DELETE]: false, [JOBS]: false });
  expect(hovered("shop", "cart")).toEqual({ [DELETE]: true, [JOBS]: false });
  expect(capabilities.values("pods", keys)[DELETE]).toBe(false);

  hover("api", {});
  expect(hovered("shop", "web")).toEqual({ [DELETE]: true, [JOBS]: true });
  await settled();
  hover("web", {});
  await settled();
  expect(hovered("shop", "web")[DELETE]).toBe(false);
  capabilities.closed("pods");
  expect(hovered("shop", "web")[DELETE]).toBe(true);
});

test("a review that fails is asked again by the next ask of the same, and a no it was to ask again holds no more", async () => {
  vi.useFakeTimers();
  try {
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error("no answer"))
      .mockResolvedValueOnce([true])
      .mockResolvedValueOnce([false])
      .mockRejectedValueOnce(new Error("no answer"));
    const report = vi.fn();
    const capabilities = new Capabilities({ invoke }, report);
    const keys = ["resource.capability.delete"];
    const object = { namespace: "shop", name: "web" };
    const BASIS = {};
    const hover = () => {
      capabilities.askHovered("pods", "qa", PODS_GVR, object, keys, BASIS);
    };
    hover();
    await vi.advanceTimersByTimeAsync(0);
    expect(report).toHaveBeenCalledOnce();
    hover();
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(2);

    const changed = vi.fn();
    capabilities.changes.subscribe(changed);
    capabilities.ask("pods", "qa", PODS_GVR, object, keys, BASIS);
    await vi.advanceTimersByTimeAsync(0);
    expect(
      capabilities.values("pods", keys)["resource.capability.delete"],
    ).toBe(false);
    changed.mockClear();
    await vi.advanceTimersByTimeAsync(REFUSED_MS);
    expect(invoke).toHaveBeenCalledTimes(4);
    expect(changed).toHaveBeenCalled();
    expect(
      capabilities.values("pods", keys)["resource.capability.delete"],
    ).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
