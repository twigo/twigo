import { expect, test, vi } from "vitest";
import type { ContextValue } from "../contextkey/when";
import { Menus } from "./menus";

const lookup =
  (context: Record<string, ContextValue>) =>
  (key: string): ContextValue | undefined =>
    context[key];

test("groups come navigation first, then by name, then the unnamed group", () => {
  const menus = new Menus();
  menus.append("editor/title", { command: "close" });
  menus.append("editor/title", { command: "zoom", group: "z" });
  menus.append("editor/title", { command: "split", group: "a" });
  menus.append("editor/title", { command: "back", group: "navigation" });
  const commands = menus
    .groups("editor/title", lookup({}))
    .map((group) => group.map((item) => item.command));
  expect(commands).toEqual([["back"], ["split"], ["zoom"], ["close"]]);
});

test("items sort by order within a group and keep registration order on ties", () => {
  const menus = new Menus();
  menus.append("view/title", { command: "c", group: "g", order: 2 });
  menus.append("view/title", { command: "a", group: "g" });
  menus.append("view/title", { command: "b", group: "g" });
  menus.append("view/title", { command: "d", group: "g", order: 1 });
  expect(
    menus.groups("view/title", lookup({}))[0]?.map((item) => item.command),
  ).toEqual(["a", "b", "d", "c"]);
});

test("an item shows only where its when holds", () => {
  const menus = new Menus();
  menus.append("resource/context", {
    command: "logs",
    when: "resource.kind == Pod",
  });
  expect(
    menus.groups("resource/context", lookup({ "resource.kind": "Pod" })),
  ).toHaveLength(1);
  expect(
    menus.groups("resource/context", lookup({ "resource.kind": "Node" })),
  ).toEqual([]);
});

test("a command without a palette item shows in the palette", () => {
  const menus = new Menus();
  menus.append("commandPalette", { command: "hidden", when: "false" });
  menus.append("commandPalette", { command: "listOnly", when: "listFocus" });
  expect(menus.shows("commandPalette", "free", lookup({}))).toBe(true);
  expect(menus.shows("commandPalette", "hidden", lookup({}))).toBe(false);
  expect(menus.shows("commandPalette", "listOnly", lookup({}))).toBe(false);
  expect(
    menus.shows("commandPalette", "listOnly", lookup({ listFocus: true })),
  ).toBe(true);
});

test("removing an item notifies and drops it", () => {
  const menus = new Menus();
  const listener = vi.fn();
  menus.changes.subscribe(listener);
  const remove = menus.append("statusBar", { command: "x" });
  remove();
  expect(menus.groups("statusBar", lookup({}))).toEqual([]);
  expect(listener).toHaveBeenCalledTimes(2);
});

test("a bad when fails at registration", () => {
  expect(() =>
    new Menus().append("statusBar", { command: "x", when: "a ==" }),
  ).toThrow();
});
