import { expect, test } from "vitest";
import { createMockBackend } from "@twigo/protocol/mock";
import { testWorkbench } from "../testing";

async function picker(scenario: Parameters<typeof createMockBackend>[0]) {
  const workbench = await testWorkbench(scenario);
  const resolved = workbench.quickAccess.resolve("ctx ");
  if (!resolved) throw new Error("no ctx provider");
  const found = await resolved.provider.items(resolved.filter, {
    lookup: () => undefined,
  });
  return { workbench, found, provider: resolved.provider };
}

test("kubeconfig:group, the default: a file that failed is a group of its own with one row that cannot be chosen, under its name from ~", async () => {
  const { found } = await picker("kubeconfigFailures");
  const broken = found.filter(({ group }) => group === "~/.kube/broken.yaml");
  expect(broken).toEqual([
    expect.objectContaining({
      label: "Cannot be parsed: unclosed bracket '[' at line 7, column 10",
      description: "kubeconfig.unparsable",
      disabled: true,
    }),
  ]);
  expect(
    found.find(({ group }) => group === "~/.kube/work/locked.yaml"),
  ).toMatchObject({ description: "kubeconfig.unreadable", disabled: true });
  expect(found.some(({ id }) => id === "kubeconfig:skipped")).toBe(false);
});

test("kubeconfig:group: a context with a problem says it on its row, and may still be chosen", async () => {
  const { found } = await picker("kubeconfigFailures");
  const orphan = found.find(({ id }) => id === "context:orphan");
  expect(orphan).toMatchObject({
    description: "orphan.internal:6443 · context.missing-user",
    state: {
      tone: "warn",
      label: 'no kubeconfig defines the user "orphan-admin"',
    },
  });
  expect(orphan?.disabled).toBeUndefined();
});

test("a catalog that lost no file has no such rows, and the rows of a good file are as before", async () => {
  const { found } = await picker("live");
  expect(found.some(({ disabled }) => disabled)).toBe(false);
  expect(
    found.find(({ id }) => id === "context:kind-local"),
  ).not.toHaveProperty("state");
});
