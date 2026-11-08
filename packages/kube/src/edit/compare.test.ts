import { expect, test } from "vitest";
import type { Backend } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import type { Picked } from "@twigo/workbench";
import { testWorkbench } from "@twigo/workbench/testing";
import { comparisons } from "./compare";

const URI = "k8s://prod-eu//v1/pods/auth/auth-api-1a4uyl1-r2bkk";

const rows = (picked: Picked) => ("items" in picked ? picked.items : picked);

test("what is typed reaches Rust as the list's text, so an object past the first rows is found by its name", async () => {
  const real = createMockBackend("ready");
  const texts: unknown[] = [];
  const backend: Backend = {
    invoke: (command, request) => real.invoke(command, request),
    subscribe: (command, request, onMessage) => {
      if (command === "list_subscribe") {
        texts.push((request as { text: unknown }).text);
      }
      return real.subscribe(command, request, onMessage);
    },
  };
  const workbench = await testWorkbench("ready", backend);
  const source = comparisons(workbench, URI, true);

  const first = rows(await source(""));
  expect(first).toHaveLength(29);
  expect(first.map(({ id }) => id)).not.toContain(URI);
  expect(first.some(({ description }) => description === "payments")).toBe(
    false,
  );

  const payments = rows(await source("  payments "));
  expect(texts).toEqual([null, "payments"]);
  expect(payments.length).toBeGreaterThan(0);
  expect(payments.every(({ id }) => id.includes("/payments/"))).toBe(true);
  expect(payments[0]?.matches).toEqual([{ start: 0, end: 8 }]);
});

const POD = "k8s://prod-eu//v1/pods/default/source";

test("forbidden cluster-wide falls back to the selected namespaces and the object's own, and the picker says so", async () => {
  const workbench = await testWorkbench("rbacNamespaces");
  workbench.spaces.update("prod-eu", (state) => ({
    ...state,
    namespaces: ["default"],
  }));
  const found = await comparisons(workbench, POD, true)("");
  expect(found).toMatchObject({
    notice:
      "You may not list pods in this cluster: these are from the namespaces selected and the object's own.",
  });
  const items = rows(found);
  expect(items.length).toBeGreaterThan(0);
  expect(items.every(({ id }) => id.includes("/default/"))).toBe(true);
});

test("forbidden in those too says that, not nothing", async () => {
  const workbench = await testWorkbench("rbacNamespaces");
  await expect(
    comparisons(
      workbench,
      "k8s://prod-eu//v1/pods/auth/auth-api-1a4uyl1-r2bkk",
      true,
    )(""),
  ).rejects.toThrow(/You may not list pods in this cluster, nor/);
  await expect(
    comparisons(workbench, "k8s://prod-eu//v1/nodes/some-node", false)(""),
  ).rejects.toThrow("You may not list nodes in this cluster.");
});

test("it searches every namespace of the kind, not the ones selected for the lists", async () => {
  const real = createMockBackend("ready");
  const asked: unknown[] = [];
  const backend: Backend = {
    invoke: (command, request) => real.invoke(command, request),
    subscribe: (command, request, onMessage) => {
      if (command === "list_subscribe") {
        asked.push((request as { namespaces: unknown }).namespaces);
      }
      return real.subscribe(command, request, onMessage);
    },
  };
  const workbench = await testWorkbench("ready", backend);
  workbench.spaces.update("prod-eu", (state) => ({
    ...state,
    namespaces: ["default"],
  }));
  const found = rows(await comparisons(workbench, URI, true)("payments"));
  expect(asked).toEqual([[]]);
  expect(found.length).toBeGreaterThan(0);
  expect(found.every(({ id }) => id.includes("/payments/"))).toBe(true);
});
