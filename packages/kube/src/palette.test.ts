import { expect, test, vi } from "vitest";
import { testWorkbench } from "@twigo/workbench/testing";
import { registerKube } from "./register";

async function withEveryEnablement() {
  const workbench = await testWorkbench();
  registerKube(workbench);
  workbench.keys.set("listFocus", true);
  workbench.keys.set("treeFocus", true);
  workbench.keys.set("resource.namespaced", true);
  workbench.keys.set("detailsOpen", true);
  workbench.keys.set("editor.open", true);
  workbench.keys.set("editor.type", "kube.list");
  workbench.keys.set("space.count", 9);
  workbench.keys.set("shellEnvironment", "failed");
  return workbench;
}

test("every registered command appears in the palette", async () => {
  const workbench = await withEveryEnablement();
  const resolved = workbench.quickAccess.resolve(">");
  const shown = await resolved?.provider.items("", {
    lookup: workbench.keys.lookup(document.body),
  });
  const ids = workbench.commands.all().map((command) => command.id);
  expect(ids.length).toBeGreaterThan(25);
  expect(shown?.map((item) => item.id).sort()).toEqual([...ids].sort());
});

test("every registered command runs from a key the user binds to it", async () => {
  const workbench = await withEveryEnablement();
  const ids = workbench.commands.all().map((command) => command.id);
  const keys = ["", "shift+"].flatMap((modifier) =>
    Array.from({ length: 36 }, (_, index) => modifier + index.toString(36)),
  );
  expect(ids.length).toBeLessThanOrEqual(keys.length);
  workbench.keybindings.register(
    "user",
    ids.map((command, index) => ({
      key: `ctrl+alt+k ${keys[index] ?? ""}`,
      command,
    })),
  );
  const execute = vi
    .spyOn(workbench.commands, "execute")
    .mockResolvedValue(true);
  const press = (code: string, init: KeyboardEventInit = {}) =>
    workbench.keybindings.dispatch(
      new KeyboardEvent("keydown", { code, cancelable: true, ...init }),
    );
  ids.forEach((id, index) => {
    const key = keys[index] ?? "";
    const char = key.slice(-1);
    const code = /\d/.test(char) ? `Digit${char}` : `Key${char.toUpperCase()}`;
    expect(press("KeyK", { ctrlKey: true, altKey: true })).toBe(true);
    expect(press(code, { shiftKey: key.startsWith("shift+") })).toBe(true);
    expect(execute).toHaveBeenLastCalledWith(
      id,
      expect.any(Function),
      undefined,
    );
  });
  expect(execute).toHaveBeenCalledTimes(ids.length);
});
