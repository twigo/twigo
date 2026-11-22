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
      label:
        "The file cannot be parsed: expected sequence start at line 7, column 10",
      description: "kubeconfig.unparsable",
      disabled: true,
    }),
  ]);
  expect(
    found.find(({ group }) => group === "~/.kube/work/locked.yaml"),
  ).toMatchObject({ description: "kubeconfig.unreadable", disabled: true });
  expect(found.some(({ id }) => id === "kubeconfig:skipped")).toBe(false);
});
