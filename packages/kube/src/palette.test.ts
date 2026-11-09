import { expect, test, vi } from "vitest";
import { testWorkbench } from "@twigo/workbench/testing";
import { EDIT_KEYS } from "./edit/services";
import { registerKube } from "./register";

async function withEveryEnablement() {
  const workbench = await testWorkbench();
  registerKube(workbench);
  workbench.keys.set("listFocus", true);
  workbench.keys.set("treeFocus", true);
  workbench.keys.set("resource.namespaced", true);
  workbench.keys.set("detailsOpen", true);
  workbench.keys.set("listMarked", true);
  workbench.keys.set("resource.selected", true);
  workbench.keys.set("resource.logs", true);
  workbench.keys.set("logsFocus", true);
  workbench.keys.set("logLines", true);
  workbench.keys.set("panelVisible", true);
  workbench.keys.set("panelMaximized", true);
  workbench.keys.set("editor.open", true);
  workbench.keys.set("editor.type", "kube.list");
  workbench.keys.set("space.count", 9);
  workbench.keys.set("context.mode", "read-only");
  workbench.keys.set("context.readOnly", true);
  workbench.keys.set("context.unlocked", true);
  workbench.keys.set("shellEnvironment", "failed");
  workbench.keys.set("inQuickOpen", true);
  workbench.keys.set("quickOpenToSide", true);
  workbench.keys.set("operationCountingDown", true);
  workbench.keys.set("space.id", "dev");
  workbench.keys.set("operationUndo", ["dev"]);
  workbench.keys.set("resource.scalable", true);
  for (const key of EDIT_KEYS) workbench.keys.set(key, true);
  for (const capability of [
    "resource.capability.delete",
    "marked.capability.delete",
    "resource.capability.patch",
    "resource.capability.patch/scale",
    "capability.create.pods/eviction",
    "capability.create.jobs.batch",
  ])
    workbench.keys.set(capability, true);
  return workbench;
}

const KINDS = [
  { group: "", kind: "Node", commands: /^k8s\.node\./ },
  { group: "apps", kind: "Deployment", commands: /^k8s\.resource\.restart$/ },
  {
    group: "batch",
    kind: "CronJob",
    commands: /^k8s\.(cronjob\.|resource\.(suspend|resume)$)/,
  },
] as const;

test("every registered command appears in the palette", async () => {
  const workbench = await withEveryEnablement();
  const resolved = workbench.quickAccess.resolve(">");
  const shown = new Set<string>();
  for (const { group, kind } of KINDS) {
    for (const state of [false, true]) {
      workbench.keys.set("resource.group", group);
      workbench.keys.set("resource.kind", kind);
      workbench.keys.set("resource.cordoned", state);
      workbench.keys.set("resource.suspended", state);
      const items = await resolved?.provider.items("", {
        lookup: workbench.keys.lookup(document.body),
      });
      for (const item of items ?? []) shown.add(item.id);
    }
  }
  const ids = workbench.commands
    .all()
    .map((command) => command.id)
    .filter((id) => id !== "k8s.logs.open");
  expect(ids.length).toBeGreaterThan(25);
  expect([...shown].sort()).toEqual([...ids].sort());
});

test("every registered command runs from a key the user binds to it", async () => {
  const workbench = await withEveryEnablement();
  const ids = workbench.commands.all().map((command) => command.id);
  const keys = ["k", "j"].flatMap((chord) =>
    ["", "shift+"].flatMap((modifier) =>
      Array.from({ length: 36 }, (_, index) => ({
        chord,
        key: modifier + index.toString(36),
      })),
    ),
  );
  expect(ids.length).toBeLessThanOrEqual(keys.length);
  workbench.keybindings.register(
    "user",
    ids.map((command, index) => {
      const { chord, key } = keys[index] ?? { chord: "", key: "" };
      return { key: `ctrl+alt+${chord} ${key}`, command };
    }),
  );
  const execute = vi
    .spyOn(workbench.commands, "execute")
    .mockResolvedValue(true);
  const press = (code: string, init: KeyboardEventInit = {}) =>
    workbench.keybindings.dispatch(
      new KeyboardEvent("keydown", { code, cancelable: true, ...init }),
    );
  ids.forEach((id, index) => {
    const { group, kind } =
      KINDS.find(({ commands }) => commands.test(id)) ?? KINDS[1];
    workbench.keys.set("resource.group", group);
    workbench.keys.set("resource.kind", kind);
    const undoing = /\.(uncordon|resume)$/.test(id);
    workbench.keys.set("resource.cordoned", undoing);
    workbench.keys.set("resource.suspended", undoing);
    const { chord, key } = keys[index] ?? { chord: "", key: "" };
    const char = key.slice(-1);
    const code = /\d/.test(char) ? `Digit${char}` : `Key${char.toUpperCase()}`;
    expect(
      press(`Key${chord.toUpperCase()}`, { ctrlKey: true, altKey: true }),
    ).toBe(true);
    expect(press(code, { shiftKey: key.startsWith("shift+") })).toBe(true);
    expect(execute).toHaveBeenLastCalledWith(
      id,
      expect.any(Function),
      undefined,
    );
  });
  expect(execute).toHaveBeenCalledTimes(ids.length);
});
