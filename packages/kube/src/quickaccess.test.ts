import { act } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ListView, type ListQuery, type Resource } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import type { QuickAccessContext } from "@twigo/workbench";
import { testWorkbench } from "@twigo/workbench/testing";
import RESOURCES from "../../protocol/src/mock/resources.json";
import { cellTone } from "./columns";
import { PODS } from "./kinds";
import { registerKube } from "./register";
import { firstRows, namespacesOf } from "./quickaccess";
import { listUri, objectUri } from "./uri";

const NOWHERE: QuickAccessContext = { lookup: () => undefined };
const opening = (): QuickAccessContext => ({ lookup: () => undefined });
const DISCOVERY: readonly Resource[] = RESOURCES;

async function kube() {
  const workbench = await testWorkbench();
  registerKube(workbench);
  const run = async (value: string, context = opening()) => {
    const resolved = workbench.quickAccess.resolve(value);
    if (!resolved) throw new Error(`no provider for ${value}`);
    const items = await resolved.provider.items(resolved.filter, context);
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
    ["po payments", "Pods", "in payments"],
    [
      "po payments /api app=web tier!=db @prod-eu",
      "Pods",
      "in payments /api app=web,tier!=db @prod-eu",
    ],
    ["  deploy   /web ", "Deployments", "/web"],
  ])("%s", async (input, label, description) => {
    const { run } = await kube();
    const { items } = await run(`:${input}`);
    expect(items).toMatchObject([{ label, description }]);
  });

  test("an empty query lists every resource", async () => {
    const { run } = await kube();
    const { items } = await run(":  ");
    expect(items).toHaveLength(DISCOVERY.length);
  });

  test.each([
    ["po", "Pods"],
    ["pod", "Pods"],
    ["Pod", "Pods"],
    ["deploy", "Deployments"],
    ["ev", "Events"],
    ["crd", "Custom Resource Definitions"],
    ["netpol", "Network Policies"],
  ])("%s names %s on recorded discovery", async (name, label) => {
    const { run } = await kube();
    const { items } = await run(`:${name} payments`);
    expect(items).toMatchObject([{ label }]);
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

test.each([
  ["payments", ["payments"]],
  ["payments,auth", ["payments", "auth"]],
  ["payments,", ["payments"]],
  ["all", []],
  ["payments,all", undefined],
  ["all,payments", undefined],
  ["Payments", undefined],
  ["a/b", undefined],
  ["-a", undefined],
  [",", undefined],
])(": the word %s names the namespaces %j", (word, namespaces) => {
  expect(namespacesOf(word)).toEqual(namespaces);
});

test(": several namespaces split on commas, described as typed and opened as one sorted list", async () => {
  const { workbench, run } = await kube();
  const open = vi
    .spyOn(workbench.editors, "open")
    .mockImplementation(() => undefined);
  const query = await run(":po payments,auth,payments");
  expect(query.items).toMatchObject([
    { label: "Pods", description: "in payments, auth, payments" },
  ]);
  await query.accept();
  expect(open).toHaveBeenCalledWith(
    "k8s-list://prod-eu/v1/pods?ns=auth%2Cpayments",
    { side: false },
  );
});

test(": all opens every namespace, and a word that is no namespace gives nothing to open", async () => {
  const { workbench, run } = await kube();
  const open = vi
    .spyOn(workbench.editors, "open")
    .mockImplementation(() => undefined);
  const all = await run(":po all");
  expect(all.items).toMatchObject([{ description: "in all" }]);
  await all.accept();
  expect(open).toHaveBeenCalledWith("k8s-list://prod-eu/v1/pods", {
    side: false,
  });

  for (const word of ["Payments", "a/b", "payments,all"]) {
    const asked = await run(`:po ${word}`);
    expect(asked.items).toEqual([]);
  }
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

test(": a row that names another space's context leads with its tile, and one that names the space shown, or no context, has none", async () => {
  const { workbench, run } = await kube();
  expect(workbench.spaces.active?.id).toBe("prod-eu");
  const [elsewhere] = (await run(":deploy payments @kind-local")).items;
  expect(elsewhere?.tile).toEqual({ name: "kind-local", color: "blue" });
  expect(elsewhere?.description).toBe("in payments @kind-local");
  expect((await run(":deploy @prod-eu")).items[0]?.tile).toBeUndefined();
  expect((await run(":deploy payments")).items[0]?.tile).toBeUndefined();
  expect(
    (await run(":deploy payments @nowhere")).items[0]?.tile,
  ).toBeUndefined();
});

test("an unknown resource gives nothing to open", async () => {
  const { run } = await kube();
  expect((await run(":gizmos payments")).items).toEqual([]);
});

test("ns lists all namespaces, the current ones ticked under Selected, then the others, and says all namespaces is the current scope when it is", async () => {
  const { workbench, run } = await kube();
  expect((await run("ns ")).items[0]).toMatchObject({
    label: "All namespaces",
    description: "current",
  });
  workbench.spaces.update("prod-eu", (state) => ({
    ...state,
    namespaces: ["auth", "payments"],
  }));
  const [all, ...rest] = (await run("ns ")).items;
  expect(all).toMatchObject({
    id: "all namespaces",
    label: "All namespaces",
    description: "new namespaces join",
  });
  expect(all?.checked).toBeUndefined();
  expect(
    rest
      .slice(0, 2)
      .map(({ label, checked, group }) => [label, checked, group]),
  ).toEqual([
    ["auth", true, "Selected"],
    ["payments", true, "Selected"],
  ]);
  const others = rest.slice(2);
  expect(others.length).toBeGreaterThan(8);
  expect(
    others.every(
      ({ checked, group }) => checked === false && group === "Namespaces",
    ),
  ).toBe(true);
  expect(others.map((item) => item.label)).not.toContain("payments");
});

test("ns ranks every namespace the filter matches by its score, ticked or not, with no heading and All namespaces after them", async () => {
  const { workbench, run } = await kube();
  workbench.spaces.update("prod-eu", (state) => ({
    ...state,
    namespaces: ["payments", "search"],
  }));
  const { items } = await run("ns c");
  const labels = items.map(({ label }) => label);
  expect(labels[0]).toBe("checkout");
  expect(labels.indexOf("batch")).toBeLessThan(labels.indexOf("search"));
  expect(labels[labels.length - 1]).toBe("All namespaces");
  expect(items.every(({ group }) => group === undefined)).toBe(true);
  expect(items.find(({ label }) => label === "search")?.checked).toBe(true);
});

test("ns takes a row alone, or the ticked set sorted, and none ticked or the All row is every namespace", async () => {
  const { workbench, run } = await kube();
  const scope = () => workbench.spaces.state("prod-eu").namespaces;
  const payments = await run("ns paym");
  expect(payments.items.map((item) => item.label)).toEqual(["payments"]);
  await payments.accept();
  expect(scope()).toEqual(["payments"]);

  const provider = workbench.quickAccess.resolve("ns ")?.provider;
  if (!provider?.acceptChecked) throw new Error("no ticked set");
  await act(() => provider.acceptChecked?.(["search", "auth", "search"]));
  expect(scope()).toEqual(["auth", "search"]);

  await act(() => provider.acceptChecked?.([]));
  expect(scope()).toEqual([]);

  await payments.accept();
  const all = await run("ns ");
  await all.accept(0);
  expect(scope()).toEqual([]);
});

test("ns says in words what the ticked set is", async () => {
  const { workbench } = await kube();
  const words = workbench.quickAccess.resolve("ns ")?.provider.checkedWords;
  expect([0, 1, 3].map((count) => words?.(count))).toEqual([
    "all namespaces",
    "1 namespace",
    "3 namespaces",
  ]);
});

test("ns asks for the namespaces once an opening, whatever is typed", async () => {
  const { workbench, run } = await kube();
  const invoke = vi.spyOn(workbench.backend, "invoke");
  const context = opening();
  for (const typed of ["ns ", "ns p", "ns pa", "ns pay"]) {
    await run(typed, context);
  }
  const asked = () =>
    invoke.mock.calls.filter(([command]) => command === "namespaces_list");
  expect(asked()).toHaveLength(1);
  await run("ns ", opening());
  expect(asked()).toHaveLength(2);
});

test("ns offers the current namespaces ticked and a typed name where namespaces may not be listed", async () => {
  const workbench = await testWorkbench("forbidden");
  registerKube(workbench);
  workbench.spaces.update("prod-eu", (state) => ({
    ...state,
    namespaces: ["team-a"],
  }));
  const rows = async (typed: string) => {
    const resolved = workbench.quickAccess.resolve(`ns ${typed}`);
    if (!resolved) throw new Error("no ns provider");
    const items = await resolved.provider.items(resolved.filter, opening());
    return items.map(({ label, checked, description }) => [
      label,
      checked,
      description,
    ]);
  };
  expect(await rows("")).toEqual([
    ["All namespaces", undefined, "new namespaces join"],
    ["team-a", true, undefined],
  ]);
  expect(await rows("team-b")).toEqual([
    ["team-b", false, "you may not list namespaces"],
  ]);
  expect(await rows("team-a")).toEqual([["team-a", true, undefined]]);

  for (const invalid of ["Team A", "a/b", "-a"]) {
    expect((await rows(invalid)).map(([label]) => label)).not.toContain(
      invalid,
    );
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

afterEach(() => {
  vi.useRealTimers();
});

const PODS_OF = (namespaces: string[]): ListQuery => ({
  space: "prod-eu",
  gvr: PODS,
  namespaced: true,
  namespaces,
  labelSelector: null,
  fieldSelector: null,
  owners: null,
  text: null,
  columns: null,
  sort: null,
  countBy: null,
  groupBy: null,
  values: null,
});

test("the first rows wait for a part that has not listed, and come with the rows of the others when the wait ends", async () => {
  vi.useFakeTimers();
  const total = async (scenario: "ready" | "partsQueued", names: string[]) => {
    const rows = firstRows(
      new ListView(createMockBackend(scenario), PODS_OF(names)),
    );
    await vi.advanceTimersByTimeAsync(3500);
    return (await rows).total;
  };
  const four = ["auth", "default", "ledger", "payments"];
  const whole = await total("ready", four);
  expect(whole).toBeGreaterThan(0);
  expect(await total("partsQueued", [...four, "search"])).toBe(whole);
});
