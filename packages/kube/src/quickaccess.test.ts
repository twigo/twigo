import { act } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { Resource } from "@twigo/protocol";
import type { QuickAccessContext } from "@twigo/workbench";
import { testWorkbench } from "@twigo/workbench/testing";
import RESOURCES from "../../protocol/src/mock/resources.json";
import { cellTone } from "./columns";
import { PODS } from "./kinds";
import { registerKube } from "./register";
import { parseK9s, resolveResource } from "./quickaccess";
import { listUri, objectUri } from "./uri";

const NOWHERE: QuickAccessContext = { lookup: () => undefined };
const DISCOVERY: readonly Resource[] = RESOURCES;

async function kube() {
  const workbench = await testWorkbench();
  registerKube(workbench);
  const run = async (value: string) => {
    const resolved = workbench.quickAccess.resolve(value);
    if (!resolved) throw new Error(`no provider for ${value}`);
    const items = await resolved.provider.items(resolved.filter, NOWHERE);
    return {
      items,
      provider: resolved.provider,
      accept: (index = 0, side = false) => {
        const item = items[index];
        if (!item) throw new Error(`no item ${String(index)}`);
        return act(() =>
          resolved.provider.accept(item, resolved.filter, NOWHERE, { side }),
        );
      },
    };
  };
  return { workbench, run };
}

describe("the k9s grammar", () => {
  test.each([
    ["po", { resource: "po" }],
    ["po payments", { resource: "po", namespace: "payments" }],
    [
      "po payments /api app=web tier!=db @prod-eu",
      {
        resource: "po",
        namespace: "payments",
        text: "api",
        labels: "app=web,tier!=db",
        context: "prod-eu",
      },
    ],
    ["  deploy   /web ", { resource: "deploy", text: "web" }],
  ])("%s", (input, query) => {
    expect(parseK9s(input)).toEqual(query);
  });

  test("an empty query is none", () => {
    expect(parseK9s("  ")).toBeUndefined();
  });

  test.each([
    ["po", "/pods"],
    ["pod", "/pods"],
    ["Pod", "/pods"],
    ["deploy", "apps/deployments"],
    ["ev", "/events"],
    ["crd", "apiextensions.k8s.io/customresourcedefinitions"],
    ["netpol", "networking.k8s.io/networkpolicies"],
  ])("%s resolves to %s on recorded discovery", (name, key) => {
    const found = resolveResource(DISCOVERY, name);
    expect(found && `${found.gvr.group}/${found.gvr.resource}`).toBe(key);
  });
});

test(": suggests resources while the name is typed", async () => {
  const { run } = await kube();
  const { items } = await run(":deplo");
  expect(items[0]).toMatchObject({
    label: "Deployments",
    matches: [{ start: 0, end: 5 }],
    description: "deploy · deployments",
  });
});

test(": opens the list that the query names", async () => {
  const { workbench, run } = await kube();
  const open = vi
    .spyOn(workbench.editors, "open")
    .mockImplementation(() => undefined);
  const query = await run(":po payments /api app=web");
  expect(query.items).toMatchObject([
    { label: "Pods", description: "in payments /api app=web" },
  ]);
  await query.accept();
  expect(open).toHaveBeenCalledWith(
    "k8s-list://prod-eu/v1/pods?ns=payments&q=api&l=app%3Dweb",
    { side: false },
  );
});

test(": with @context opens that context's space first", async () => {
  const { workbench, run } = await kube();
  const open = vi
    .spyOn(workbench.editors, "open")
    .mockImplementation(() => undefined);
  await (await run(":deploy @kind-local")).accept();
  expect(workbench.spaces.active?.id).toBe("kind-local");
  expect(open).toHaveBeenCalledWith(
    "k8s-list://kind-local/apps/v1/deployments",
    { side: false },
  );
});

test("an unknown resource gives nothing to open", async () => {
  const { run } = await kube();
  expect((await run(":gizmos payments")).items).toEqual([]);
});

test("ns scopes the active space", async () => {
  const { workbench, run } = await kube();
  const all = await run("ns ");
  expect(all.items[0]).toMatchObject({
    label: "all namespaces",
    description: "current",
  });
  const payments = await run("ns paym");
  expect(payments.items.map((item) => item.label)).toEqual(["payments"]);
  await payments.accept();
  expect(workbench.spaces.state("prod-eu").namespaces).toEqual(["payments"]);
});

test("ns takes a typed name where namespaces may not be listed", async () => {
  const workbench = await testWorkbench("forbidden");
  registerKube(workbench);
  const resolved = workbench.quickAccess.resolve("ns team-a");
  if (!resolved) throw new Error("no ns provider");
  const items = await resolved.provider.items(resolved.filter, NOWHERE);
  expect(items.map((item) => item.label)).toEqual(["all namespaces", "team-a"]);
  const [, typed] = items;
  if (!typed) throw new Error("no typed item");
  await act(() => resolved.provider.accept(typed, resolved.filter, NOWHERE));
  expect(workbench.spaces.state("prod-eu").namespaces).toEqual(["team-a"]);

  for (const invalid of ["Team A", "a/b", "-a"]) {
    const asked = workbench.quickAccess.resolve(`ns ${invalid}`);
    if (!asked) throw new Error("no ns provider");
    const offered = await asked.provider.items(asked.filter, NOWHERE);
    expect(offered.map((item) => item.label)).not.toContain(invalid);
  }
});

test("no prefix finds pods by name and opens the pick's list with its details", async () => {
  const { workbench, run } = await kube();
  const open = vi
    .spyOn(workbench.editors, "open")
    .mockImplementation(() => undefined);
  const found = await run("auth-api-1a4");
  expect(found.items.length).toBeGreaterThan(0);
  expect(found.items.every((item) => item.label.includes("auth-api-1a4"))).toBe(
    true,
  );
  const [first] = found.items;
  await found.accept();
  expect(open).toHaveBeenCalledWith(
    `k8s-list://prod-eu/v1/pods?q=${first?.label ?? ""}`,
    { preview: true, side: false },
  );
});

test("no prefix opens the pick of an earlier query that resolved first", async () => {
  const { workbench } = await kube();
  const open = vi
    .spyOn(workbench.editors, "open")
    .mockImplementation(() => undefined);
  const provider = workbench.quickAccess.resolve("auth")?.provider;
  if (!provider) throw new Error("no provider");
  const [auth] = await Promise.all([
    provider.items("auth-api-1a4", NOWHERE),
    provider.items("ledger", NOWHERE),
  ]);
  const [first] = auth;
  if (!first) throw new Error("no auth pods");
  await act(() => provider.accept(first, "auth-api-1a4", NOWHERE));
  expect(open).toHaveBeenCalledWith(
    `k8s-list://prod-eu/v1/pods?q=${first.label}`,
    { preview: true, side: false },
  );
});

test(": opens a list to the side", async () => {
  const { workbench, run } = await kube();
  const open = vi
    .spyOn(workbench.editors, "open")
    .mockImplementation(() => undefined);
  const query = await run(":deploy");
  expect(query.provider).toMatchObject({ hint: "Lists", toSide: true });
  await query.accept(0, true);
  expect(open).toHaveBeenCalledWith("k8s-list://prod-eu/apps/v1/deployments", {
    side: true,
  });
});

test("no prefix shows a pod's kind, namespace, what matched and only an abnormal status, in its tone", async () => {
  const { run } = await kube();
  const { items } = await run("auth-api");
  expect(items.length).toBeGreaterThan(0);
  for (const item of items) {
    expect(item).toMatchObject({
      group: "Pods",
      kind: "Pod",
      description: "auth",
      matches: [{ start: 0, end: 8 }],
    });
    expect(item.icon).toBeDefined();
    if (item.state) {
      expect(item.state.tone).toBe(cellTone(PODS, "Status", item.state.label));
    }
  }
  expect(items.some((item) => item.state?.tone === "error")).toBe(true);
  expect(items.some((item) => item.state?.tone === "warn")).toBe(true);
  expect(items.some((item) => item.state === undefined)).toBe(true);
  expect(
    items.find((item) => item.state?.label === "ContainerCreating")?.state
      ?.pulse,
  ).toBe(true);
  const upper = await run("AUTH-API");
  expect(upper.items.length).toBe(items.length);
  expect(upper.items[0]?.matches).toEqual([{ start: 0, end: 8 }]);
});

const DEPLOYMENT = objectUri({
  space: "prod-eu",
  gvr: { group: "apps", version: "v1", resource: "deployments" },
  namespace: "auth",
  name: "auth-api",
});
const CONFIG = objectUri({
  space: "prod-eu",
  gvr: { group: "", version: "v1", resource: "configmaps" },
  namespace: "auth",
  name: "auth-api-config",
});
const LIST = listUri({ space: "prod-eu", gvr: PODS, namespaces: ["auth"] });

async function withRecent() {
  const tools = await kube();
  await tools.run(":");
  tools.workbench.spaces.update("prod-eu", (state) => ({
    ...state,
    recent: [
      { uri: CONFIG, title: "auth-api-config" },
      { uri: LIST, title: "Pods" },
      { uri: DEPLOYMENT, title: "auth-api" },
    ],
  }));
  return tools;
}

test("no prefix shows the space's recent editors first, newest first, then the pods", async () => {
  const { run } = await withRecent();
  const all = await run("");
  const recent = all.items.filter((item) => item.group === "Recent");
  expect(recent).toMatchObject([
    { label: "auth-api-config", description: "auth", kind: "ConfigMap" },
    { label: "Pods", description: "auth", kind: "List" },
    { label: "auth-api", description: "auth", kind: "Deployment" },
  ]);
  expect(all.items.slice(0, 3)).toEqual(recent);
  expect(all.items[3]?.group).toBe("Pods");
});

test("no prefix shows the recent editors that match, best first, and opens one", async () => {
  const { workbench, run } = await withRecent();
  const open = vi
    .spyOn(workbench.editors, "open")
    .mockImplementation(() => undefined);
  const found = await run("auth-api");
  const recent = found.items.filter((item) => item.group === "Recent");
  expect(recent.map((item) => [item.label, item.matches])).toEqual([
    ["auth-api", [{ start: 0, end: 8 }]],
    ["auth-api-config", [{ start: 0, end: 8 }]],
  ]);
  await found.accept(0);
  expect(open).toHaveBeenLastCalledWith(DEPLOYMENT, { side: false });
  await found.accept(1, true);
  expect(open).toHaveBeenLastCalledWith(CONFIG, { side: true });
  const pod = found.items.findIndex((item) => item.group === "Pods");
  await found.accept(pod, true);
  expect(open).toHaveBeenLastCalledWith(
    `k8s-list://prod-eu/v1/pods?q=${found.items[pod]?.label ?? ""}`,
    { preview: true, side: true },
  );
});

test("a space's connection carries its Kubernetes version once connected", async () => {
  const { workbench } = await kube();
  await vi.waitFor(() => {
    expect(workbench.spaceStatus.get("prod-eu")).toEqual({
      tone: "ok",
      label: "Connected",
      version: "v1.33.4",
    });
  });
  expect(workbench.spaceStatus.get("staging")).toEqual({
    tone: "idle",
    label: "Not connected yet",
  });
});
