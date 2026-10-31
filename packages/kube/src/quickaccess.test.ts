import { act } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { Resource } from "@twigo/protocol";
import type { QuickAccessContext } from "@twigo/workbench";
import { testWorkbench } from "@twigo/workbench/testing";
import RESOURCES from "../../protocol/src/mock/resources.json";
import { registerKube } from "./register";
import { parseK9s, resolveResource } from "./quickaccess";

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
      accept: (index = 0) => {
        const item = items[index];
        if (!item) throw new Error(`no item ${String(index)}`);
        return act(() =>
          resolved.provider.accept(item, resolved.filter, NOWHERE),
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

test("no prefix finds pods by name and shows the pick in the Inspector", async () => {
  const { workbench, run } = await kube();
  workbench.spaces.setPart("prod-eu", "secondary", { visible: false });
  const found = await run("auth-api-1a4");
  expect(found.items.length).toBeGreaterThan(0);
  expect(found.items.every((item) => item.label.includes("auth-api-1a4"))).toBe(
    true,
  );
  await found.accept();
  expect(workbench.spaces.state("prod-eu").parts.secondary.visible).toBe(true);
});
