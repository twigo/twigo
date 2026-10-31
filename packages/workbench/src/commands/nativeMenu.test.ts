import { expect, test } from "vitest";
import { parseKeys, type Platform } from "../keybindings/chord";
import { testWorkbench } from "../testing";
import { accelerator, nativeMenus } from "./nativeMenu";

const of = (keys: string, platform: Platform = "mac") => {
  const [chord] = parseKeys(keys, platform);
  return accelerator(chord, platform);
};

test.each([
  ["mod+b", "mac", "Cmd+B"],
  ["mod+b", "linux", "Ctrl+B"],
  ["mod+shift+p", "mac", "Shift+Cmd+P"],
  ["mod+alt+b", "mac", "Alt+Cmd+B"],
  ["mod+1", "mac", "Cmd+1"],
  ["mod+\\", "mac", "Cmd+\\"],
  ["mod+?", "mac", "Shift+Cmd+/"],
  ["mod+enter", "mac", "Cmd+Enter"],
  ["ctrl+f5", "linux", "Ctrl+F5"],
  ["meta+up", "linux", "Super+Up"],
] as const)("%s on %s is %s", (keys, platform, expected) => {
  expect(of(keys, platform)).toBe(expected);
});

test("a character outside US keys has no accelerator", () => {
  expect(of("mod+é")).toBeUndefined();
});

test("the menu bar lists the core's items, with accelerators only where the OS may take the key", async () => {
  const workbench = await testWorkbench();
  const menus = nativeMenus(workbench);
  expect(menus.map((menu) => menu.title)).toEqual([
    "File",
    "Edit",
    "View",
    "Go",
    "Window",
    "Help",
  ]);
  const view = menus.find((menu) => menu.title === "View");
  expect(
    view?.groups.map((group) =>
      group.map((item) => [item.title, item.accelerator]),
    ),
  ).toEqual([
    [
      ["Toggle Primary Side Bar", "Cmd+B"],
      ["Toggle Panel", "Cmd+J"],
      ["Toggle Secondary Side Bar", "Alt+Cmd+B"],
    ],
    [["Move View…", undefined]],
    [
      ["Keep Editor", undefined],
      ["Move Editor into New Group to the Right", "Cmd+\\"],
      ["Move Editor into New Group Below", undefined],
    ],
  ]);
  expect(menus.find((menu) => menu.title === "Edit")?.groups).toEqual([]);
});

test("a binding with a when keeps its key away from the menu", async () => {
  const workbench = await testWorkbench();
  workbench.keybindings.register("user", [
    {
      key: "mod+shift+m",
      command: "workbench.action.moveView",
      when: "listFocus",
    },
  ]);
  const view = nativeMenus(workbench).find((menu) => menu.title === "View");
  expect(view?.groups[1]).toEqual([
    {
      command: "workbench.action.moveView",
      title: "Move View…",
      accelerator: undefined,
    },
  ]);
});
