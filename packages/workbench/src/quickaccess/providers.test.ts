import { createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { expect, test } from "vitest";
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
  expect(
    await workbench.backend.invoke("state_get", "quickaccess/history"),
  ).toBe(JSON.stringify(["workbench.action.togglePanel"]));
});

test("ctx lists the spaces, then the contexts without one", async () => {
  const { found, workbench, provider } = await items("ctx ");
  expect(found.map((item) => [item.group, item.label])).toEqual([
    ["Spaces", "prod-eu"],
    ["Spaces", "staging"],
    ["Spaces", "dev"],
    ["Spaces", "dev+qa"],
    ["Contexts", "qa"],
    ["Contexts", "kind-local"],
  ]);
  const local = found.find((item) => item.label === "kind-local");
  if (!local) throw new Error("no kind-local");
  await act(() => provider.accept(local, "", NOWHERE));
  expect(workbench.spaces.active?.id).toBe("kind-local");
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
  expect(found).toEqual([{ id: "1", label: "spec", description: "line 12" }]);
  await provider.accept(found[0] ?? { id: "", label: "" }, "spe", NOWHERE);
  expect(revealed).toBe("spec");
  cleanup();
});
