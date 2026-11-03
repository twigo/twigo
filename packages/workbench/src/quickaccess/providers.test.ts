import { createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { expect, test } from "vitest";
import { Changes } from "../changes";
import { testWorkbench } from "../testing";
import { WorkbenchView } from "../WorkbenchView";
import type { QuickAccessContext, QuickPickItem } from "./registry";

const NOWHERE: QuickAccessContext = { lookup: () => undefined };

async function items(prefix: string, filter = "", context = NOWHERE) {
  const workbench = await testWorkbench();
  const resolved = workbench.quickAccess.resolve(prefix + filter);
  if (!resolved) throw new Error(`no provider for ${prefix}`);
  const found = await resolved.provider.items(resolved.filter, context);
  return { workbench, found, provider: resolved.provider };
}

const labels = (found: readonly QuickPickItem[]) =>
  found.map((item) => item.label);

test("> lists enabled commands with their keys and filters them", async () => {
  const { found } = await items(">");
  const toggle = found.find(
    (item) => item.id === "workbench.action.toggleSidebarVisibility",
  );
  expect(toggle).toMatchObject({
    label: "View: Toggle Primary Side Bar",
    keybinding: "⌘B",
  });
  expect(
    found.some((item) => item.id === "workbench.action.closeActiveEditor"),
  ).toBe(false);
  const { found: some } = await items(">", "panel");
  expect(labels(some)).toContain("View: Toggle Panel");
  expect(labels(some)).not.toContain("Go: Show All Commands");
});

test("> hides what a commandPalette item hides", async () => {
  const workbench = await testWorkbench();
  workbench.menus.append("commandPalette", {
    command: "workbench.action.togglePanel",
    when: "false",
  });
  const resolved = workbench.quickAccess.resolve(">");
  const found = (await resolved?.provider.items("", NOWHERE)) ?? [];
  expect(found.some((item) => item.id === "workbench.action.togglePanel")).toBe(
    false,
  );
});

test("> puts what ran last first and remembers it in the backend", async () => {
  const { workbench, provider } = await items(">");
  const panel = {
    id: "workbench.action.togglePanel",
    label: "View: Toggle Panel",
  };
  await act(() => provider.accept(panel, "", NOWHERE));
  const found = await provider.items("", NOWHERE);
  expect(found[0]?.id).toBe("workbench.action.togglePanel");
  expect(workbench.spaces.state("prod-eu").parts.panel.visible).toBe(true);
  await workbench.state.settled();
  const stored = await workbench.backend.invoke("state_load", null);
  expect(stored.app["quickaccess/history"]).toBe(
    JSON.stringify(["workbench.action.togglePanel"]),
  );
});

test("ctx lists the open spaces, then the other contexts by the file that defines them, in their colours", async () => {
  const { found, workbench, provider } = await items("ctx ");
  expect(found.map((item) => [item.group, item.label])).toEqual([
    ["Open spaces", "prod-eu"],
    ["Open spaces", "staging"],
    ["Open spaces", "dev"],
    ["~/.kube/config", "qa"],
    ["~/.kube/kind.yaml", "kind-local"],
  ]);
  expect(found[0]).toMatchObject({
    tile: { name: "prod-eu", color: "red" },
    description: "4f2a9c1e7b.gr7.eu-west-1.eks.amazonaws.com",
    keybinding: "⌘1",
  });
  expect(found[3]).toMatchObject({
    tile: { name: "qa", color: workbench.colors.of("qa") },
    description: "qa.internal:6443",
  });
  expect(found[3]?.keybinding).toBeUndefined();
  workbench.colors.choose("qa", "purple");
  const again = await provider.items("", NOWHERE);
  expect(again.find((item) => item.label === "qa")?.tile).toEqual({
    name: "qa",
    color: "purple",
  });
  expect(provider.acceptLabel).toBe("Switch");
  const local = found.find((item) => item.label === "kind-local");
  if (!local) throw new Error("no kind-local");
  await act(() => provider.accept(local, "", NOWHERE));
  expect(workbench.spaces.active?.id).toBe("kind-local");
});

test("ctx says each open space's connection, the version alone while connected", async () => {
  const { workbench, provider } = await items("ctx ");
  workbench.spaceStatus.register({
    changes: new Changes(),
    status: (space) =>
      (
        ({
          "prod-eu": { tone: "ok", label: "Connected", version: "v1.33.4" },
          staging: { tone: "warn", label: "Reconnecting", version: "v1.35.2" },
        }) as const
      )[space],
  });
  const found = await provider.items("", NOWHERE);
  expect(found.slice(0, 3).map((item) => item.state)).toEqual([
    { tone: "ok", label: "v1.33.4" },
    { tone: "warn", label: "Reconnecting" },
    undefined,
  ]);
});

test("ctx keeps its sections in order as it filters, best first in each", async () => {
  const { provider } = await items("ctx ");
  const found = await provider.items("l", NOWHERE);
  expect(found.map((item) => [item.group, item.label])).toEqual([
    ["~/.kube/kind.yaml", "kind-local"],
  ]);
  expect(found[0]?.matches).toEqual([{ start: 5, end: 6 }]);
  const some = await provider.items("a", NOWHERE);
  expect(some.map((item) => [item.group, item.label])).toEqual([
    ["Open spaces", "staging"],
    ["~/.kube/config", "qa"],
    ["~/.kube/kind.yaml", "kind-local"],
  ]);
});

test("? lists the prefixes and the bound commands", async () => {
  const { found } = await items("?");
  const prefixes = found
    .filter((item) => item.group === "Prefixes")
    .map((item) => item.label);
  expect(prefixes).toEqual(expect.arrayContaining([">", "ctx ", "@"]));
  expect(
    found.find((item) => item.label === "Go: Show All Commands"),
  ).toMatchObject({
    group: "Keybindings",
    keybinding: "⇧⌘P",
  });
});

test("@ lists the symbols the active editor publishes", async () => {
  const { workbench, provider } = await items("@");
  expect(await provider.items("", NOWHERE)).toEqual([]);
  let revealed = "";
  workbench.editors.register({
    id: "test",
    scheme: "note",
    title: () => "note",
    component: () => null,
  });
  render(createElement(WorkbenchView, { workbench }));
  act(() => {
    workbench.editors.open("note://a");
  });
  workbench.editors.publishSymbols("note://a", [
    { label: "metadata", reveal: () => (revealed = "metadata") },
    { label: "spec", detail: "line 12", reveal: () => (revealed = "spec") },
  ]);
  const found = await provider.items("spe", NOWHERE);
  expect(found).toEqual([
    {
      id: "1",
      label: "spec",
      description: "line 12",
      matches: [{ start: 0, end: 3 }],
    },
  ]);
  await provider.accept(found[0] ?? { id: "", label: "" }, "spe", NOWHERE);
  expect(revealed).toBe("spec");
  cleanup();
});
