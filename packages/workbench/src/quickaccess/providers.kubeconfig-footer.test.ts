import { afterEach, beforeEach, expect, test } from "vitest";
import { createMockBackend } from "@twigo/protocol/mock";
import { testWorkbench } from "../testing";

beforeEach(() => {
  history.replaceState(null, "", "/?variant=kubeconfig:footer");
});

afterEach(() => {
  history.replaceState(null, "", "/");
});

async function picker(scenario: Parameters<typeof createMockBackend>[0]) {
  const workbench = await testWorkbench(scenario);
  const resolved = workbench.quickAccess.resolve("ctx ");
  if (!resolved) throw new Error("no ctx provider");
  const found = await resolved.provider.items(resolved.filter, {
    lookup: () => undefined,
  });
  return { workbench, found, provider: resolved.provider };
}

test("kubeconfig:footer keeps the failed files out of the groups and ends the picker with one line that opens them", async () => {
  const { workbench, found, provider } = await picker("kubeconfigFailures");
  expect(found.some(({ group }) => group === "~/.kube/broken.yaml")).toBe(
    false,
  );
  const last = found[found.length - 1];
  expect(last).toMatchObject({
    id: "kubeconfig:skipped",
    label: "2 kubeconfig files were skipped",
  });
  expect(last?.disabled).toBeUndefined();

  if (!last) throw new Error("no last row");
  await provider.accept(last, "", { lookup: () => undefined });
  const { pick } = workbench.quickAccess.session ?? {};
  expect(pick?.placeholder).toBe("Kubeconfig files that were skipped");
  expect(pick?.items.map(({ group, disabled }) => [group, disabled])).toEqual([
    ["~/.kube/broken.yaml", true],
    ["~/.kube/work/locked.yaml", true],
  ]);
});

test("kubeconfig:footer: the line follows the filter, so a filter that matches no context leaves nothing, and it says what Enter does", async () => {
  const { found, provider } = await picker("kubeconfigFailures");
  const NOWHERE = { lookup: () => undefined };
  expect(await provider.items("zzzz", NOWHERE)).toEqual([]);
  expect(found[found.length - 1]?.acceptLabel).toBe("Show");
  expect(
    (await provider.items("skipped", NOWHERE)).map(({ id }) => id),
  ).toEqual(["kubeconfig:skipped"]);
});

test("kubeconfig:footer: a catalog that lost no file has no such line", async () => {
  const { found } = await picker("live");
  expect(found.some(({ id }) => id === "kubeconfig:skipped")).toBe(false);
});
