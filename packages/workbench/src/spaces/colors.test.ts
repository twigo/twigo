import { act } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { Context } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { StateStore } from "../state/store";
import { testWorkbench } from "../testing";
import { ContextColors } from "./colors";
import { SET_SPACE_COLOR } from "./colorCommand";

test("a kubeconfig's colour comes first, then the one chosen in Twigo, then one from the name", async () => {
  const workbench = await testWorkbench();
  const { colors } = workbench;
  expect(colors.of("prod-eu")).toBe("red");
  expect(colors.source("prod-eu")).toBe("kubeconfig");

  const automatic = colors.of("qa");
  expect(colors.source("qa")).toBe("automatic");
  expect(["blue", "purple", "green", "orange"]).toContain(automatic);

  colors.choose("qa", "red");
  expect(colors.of("qa")).toBe("red");
  expect(colors.source("qa")).toBe("chosen");
  colors.choose("prod-eu", "blue");
  expect(colors.of("prod-eu")).toBe("red");

  colors.choose("qa", undefined);
  expect(colors.of("qa")).toBe(automatic);
});

test("a colour from a name is the same in every window, and a chosen one is kept", async () => {
  const backend = createMockBackend("ready");
  const first = await testWorkbench("ready", backend);
  const names = ["qa", "kind-local", "a", "b", "c", "d", "e", "f"];
  const before = names.map((name) => first.colors.of(name));
  expect(before).not.toContain("red");
  expect(before).not.toContain("yellow");
  first.colors.choose("kind-local", "purple");
  await first.state.settled();

  const state = await StateStore.load(backend, () => undefined);
  const again = new ContextColors(first.catalog, state);
  expect(
    names.filter((name) => name !== "kind-local").map((name) => again.of(name)),
  ).toEqual(before.filter((_, index) => names[index] !== "kind-local"));
  expect(again.of("kind-local")).toBe("purple");
});

test("the colour command picks for the space the rail's menu names and leaves a kubeconfig's colour", async () => {
  const workbench = await testWorkbench();
  const { commands, quickAccess, keys, colors } = workbench;
  const run = (space: string) =>
    commands.execute(SET_SPACE_COLOR, keys.lookup(null), space);

  const picking = run("dev");
  await act(() => Promise.resolve());
  const dev = quickAccess.session?.pick;
  expect(dev?.placeholder).toContain("kubeconfig");
  dev?.resolve(dev.items.find((item) => item.id === "blue"));
  await picking;
  expect(colors.of("dev")).toBe("green");

  await act(() => workbench.spaces.open("qa"));
  const again = run("qa");
  await act(() => Promise.resolve());
  const qa = quickAccess.session?.pick;
  expect(qa?.items.map((item) => item.id)).toEqual([
    "red",
    "orange",
    "yellow",
    "green",
    "blue",
    "purple",
    "automatic",
  ]);
  qa?.resolve(qa.items.find((item) => item.id === "yellow"));
  await again;
  expect(colors.of("qa")).toBe("yellow");
});

test("the colour command does nothing for a space the rail no longer shows", async () => {
  const contexts: Context[] = ["prod-eu", "staging", "dev"].map((name) => ({
    name,
    color: null,
    source: "~/.kube/config",
    server: null,
  }));
  const backend = createMockBackend("ready");
  let send: ((next: Context[]) => void) | undefined;
  const subscribe = backend.subscribe.bind(backend);
  vi.spyOn(backend, "subscribe").mockImplementation((command, request, on) => {
    if (command !== "contexts_watch") return subscribe(command, request, on);
    send = on;
    return Promise.resolve(contexts);
  });
  const workbench = await testWorkbench("ready", backend);
  act(() => {
    send?.(contexts.filter((context) => context.name !== "staging"));
  });
  expect(workbench.spaces.list.map((space) => space.id)).toEqual([
    "prod-eu",
    "dev",
  ]);

  void workbench.commands.execute(
    SET_SPACE_COLOR,
    workbench.keys.lookup(null),
    "staging",
  );
  await act(() => Promise.resolve());
  expect(workbench.quickAccess.session).toBeUndefined();
});
