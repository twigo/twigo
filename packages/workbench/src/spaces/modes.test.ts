import { act } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { ContextAccess } from "@twigo/protocol";
import { createMockBackend, UNMARKED } from "@twigo/protocol/mock";
import { registerCore } from "../core";
import { Workbench } from "../services";
import { StateStore } from "../state/store";
import { testWorkbench } from "../testing";
import {
  RELOCK_CONTEXT,
  SET_CONTEXT_ENVIRONMENT,
  SET_CONTEXT_MODE,
  UNLOCK_CONTEXT,
} from "./modeCommands";
import { chipLabel, countdown, describeAccess, describeSource } from "./modes";

function access(fields: Partial<ContextAccess>): ContextAccess {
  return { ...UNMARKED, ...fields };
}

test("a context nobody marked that lets everything through has no chip", () => {
  expect(chipLabel(UNMARKED)).toBeUndefined();
});

test("the chip says the type and the mode", () => {
  const production = access({
    environment: "production",
    mode: "read-only",
  });
  expect(chipLabel(production)).toBe("Production · read-only");
  expect(chipLabel(access({ environment: "staging", mode: "guarded" }))).toBe(
    "Staging · guarded",
  );
  const chosen = { kind: "user" } as const;
  expect(chipLabel(access({ mode: "read-only", source: chosen }))).toBe(
    "Read-only",
  );
  expect(chipLabel(access({ mode: "guarded", source: chosen }))).toBe(
    "Guarded",
  );
});

test("a read-write that somebody chose is said, as it may override a lock", () => {
  expect(chipLabel(access({ source: { kind: "user" } }))).toBe("Read-write");
  expect(chipLabel(access({ source: { kind: "kubeconfig" } }))).toBe(
    "Read-write",
  );
});

test("read-write goes unsaid, unless the context is Production", () => {
  expect(chipLabel(access({ environment: "development" }))).toBe("Development");
  expect(chipLabel(access({ environment: "local" }))).toBe("Local");
  expect(chipLabel(access({ environment: "production" }))).toBe(
    "Production · read-write",
  );
});

test("an unlocked context says so", () => {
  const unlocked = {
    mode: "guarded",
    unlockedUntil: 1000,
  } as const;
  expect(chipLabel(access({ ...unlocked, environment: "production" }))).toBe(
    "Production · unlocked",
  );
  expect(chipLabel(access(unlocked))).toBe("Unlocked");
});

test("each source is named in words", () => {
  expect(
    describeSource({
      kind: "policyFile",
      file: "/etc/twigo/policy.json",
      pattern: "prod-*",
    }),
  ).toBe(
    "prod-* in /etc/twigo/policy.json sets this. Twigo cannot change or unlock it.",
  );
  expect(
    describeSource({
      kind: "policyFile",
      file: "/etc/twigo/policy.json",
      pattern: null,
    }),
  ).toContain("cannot be read");
  expect(describeSource({ kind: "user" })).toBe("You set this.");
  expect(describeSource({ kind: "kubeconfig" })).toContain("twigo.readOnly");
  expect(describeSource({ kind: "provider" })).toContain("provider");
  expect(describeSource({ kind: "environment", environment: "staging" })).toBe(
    "The default for Staging.",
  );
  expect(describeSource({ kind: "unlisted" })).toContain("No source lists");
  expect(describeSource({ kind: "moved" })).toContain("another cluster");
  expect(describeSource({ kind: "default" })).toBe(
    "Nothing limits this context.",
  );
});

test("the countdown rounds up and stops at zero", () => {
  expect(countdown(15 * 60 * 1000)).toBe("15:00");
  expect(countdown(14 * 60 * 1000 + 1)).toBe("14:01");
  expect(countdown(61_000)).toBe("1:01");
  expect(countdown(1)).toBe("0:01");
  expect(countdown(-5)).toBe("0:00");
});

test("context keys follow the mode and an unlock", async () => {
  const workbench = await testWorkbench();
  const { keys, commands, catalog, spaces } = workbench;
  const key = (name: string) => keys.lookup(null)(name);
  const lookup = () => keys.lookup(null);
  await act(() => Promise.resolve());
  expect(spaces.active?.id).toBe("prod-eu");
  expect(key("context.mode")).toBe("read-only");
  expect(key("context.readOnly")).toBe(true);
  expect(key("context.unlocked")).toBe(false);

  await act(() => commands.execute(UNLOCK_CONTEXT, lookup()));
  expect(key("context.mode")).toBe("guarded");
  expect(key("context.readOnly")).toBe(false);
  expect(key("context.unlocked")).toBe(true);
  expect(catalog.find("prod-eu")?.access.unlockedUntil).not.toBeNull();

  await act(() => commands.execute(RELOCK_CONTEXT, lookup()));
  expect(key("context.mode")).toBe("read-only");
  expect(key("context.unlocked")).toBe(false);

  act(() => {
    spaces.select("dev");
  });
  expect(key("context.mode")).toBe("read-write");
  expect(key("context.readOnly")).toBe(false);
});

test("unlocking and relocking follow enablement, whatever the mode", async () => {
  const { commands, keys } = await testWorkbench();
  await act(() => Promise.resolve());
  const enabled = (id: string) => commands.enabled(id, keys.lookup(null));
  expect(enabled(UNLOCK_CONTEXT)).toBe(true);
  expect(enabled(RELOCK_CONTEXT)).toBe(false);
  await act(() => commands.execute(UNLOCK_CONTEXT, keys.lookup(null)));
  expect(enabled(UNLOCK_CONTEXT)).toBe(false);
  expect(enabled(RELOCK_CONTEXT)).toBe(true);
});

test("the mode command sets the mode outright, or asks and sends what was picked", async () => {
  const { commands, keys, catalog, quickAccess } = await testWorkbench();
  await act(() => Promise.resolve());
  await act(() =>
    commands.execute(SET_CONTEXT_MODE, keys.lookup(null), {
      context: "qa",
      value: "guarded",
    }),
  );
  expect(catalog.find("qa")?.access.mode).toBe("guarded");
  expect(catalog.find("qa")?.access.source).toEqual({ kind: "user" });

  const asked = commands.execute(SET_CONTEXT_MODE, keys.lookup(null));
  await act(() => Promise.resolve());
  const pick = quickAccess.session?.pick;
  expect(pick?.items.map((item) => item.id)).toEqual([
    "read-write",
    "guarded",
    "read-only",
    "none",
  ]);
  act(() => {
    pick?.resolve(pick.items.find((item) => item.id === "read-write"));
  });
  await act(() => asked);
  expect(catalog.find("prod-eu")?.access.mode).toBe("read-write");
  expect(catalog.find("prod-eu")?.access.source).toEqual({ kind: "user" });
});

test("the palette's Default and None send no value, and the current None sends nothing", async () => {
  const { commands, keys, catalog, quickAccess, backend } =
    await testWorkbench();
  await act(() => Promise.resolve());
  const invoke = vi.spyOn(backend, "invoke");
  const pickFrom = async (command: string, id: string) => {
    const run = commands.execute(command, keys.lookup(null));
    await act(() => Promise.resolve());
    const pick = quickAccess.session?.pick;
    act(() => {
      pick?.resolve(pick.items.find((item) => item.id === id));
    });
    await act(() => run);
  };

  await pickFrom(SET_CONTEXT_MODE, "guarded");
  expect(catalog.find("prod-eu")?.access.source).toEqual({ kind: "user" });
  await pickFrom(SET_CONTEXT_MODE, "none");
  expect(catalog.find("prod-eu")?.access.source).toEqual({
    kind: "environment",
    environment: "production",
  });

  await pickFrom(SET_CONTEXT_ENVIRONMENT, "none");
  expect(catalog.find("prod-eu")?.access.environment).toBeNull();
  invoke.mockClear();
  await pickFrom(SET_CONTEXT_ENVIRONMENT, "none");
  expect(invoke).not.toHaveBeenCalled();
});

test("the rail's menu offers the mode and the type", async () => {
  const { menus } = await testWorkbench();
  const commands = menus
    .groups("space/context")
    .flat()
    .map((item) => item.command);
  expect(commands).toContain(SET_CONTEXT_MODE);
  expect(commands).toContain(SET_CONTEXT_ENVIRONMENT);
});

test("before the catalog is read the commands are off, rather than doing nothing", async () => {
  const backend = createMockBackend();
  const subscribe = backend.subscribe.bind(backend);
  vi.spyOn(backend, "subscribe").mockImplementation((command, request, on) =>
    command === "contexts_watch"
      ? new Promise(() => undefined)
      : subscribe(command, request, on),
  );
  const state = await StateStore.load(backend, () => undefined);
  const workbench = new Workbench(
    backend,
    "mac",
    { id: "us", keys: {} },
    state,
  );
  registerCore(workbench);
  void workbench.catalog.watch();
  await act(() => workbench.spaces.load());
  const { commands, keys } = workbench;
  const enabled = (id: string) => commands.enabled(id, keys.lookup(null));
  expect(enabled(SET_CONTEXT_MODE)).toBe(false);
  expect(enabled(SET_CONTEXT_ENVIRONMENT)).toBe(false);
});

test("marking a context sets its default mode and its colour", async () => {
  const { commands, keys, catalog, colors } = await testWorkbench();
  await act(() => Promise.resolve());
  expect(catalog.find("qa")?.access.environment).toBeNull();
  expect(colors.source("qa")).toBe("automatic");

  await act(() =>
    commands.execute(SET_CONTEXT_ENVIRONMENT, keys.lookup(null), {
      context: "qa",
      value: "production",
    }),
  );
  const { mode, environment, source } = catalog.find("qa")?.access ?? UNMARKED;
  expect([mode, environment]).toEqual(["read-only", "production"]);
  expect(source).toEqual({ kind: "environment", environment: "production" });
  expect(colors.of("qa")).toBe("red");
  expect(colors.source("qa")).toBe("environment");

  colors.choose("qa", "blue");
  expect(colors.of("qa")).toBe("blue");
  expect(colors.source("qa")).toBe("chosen");
});

test("a policy file's entry cannot be changed and says who set it", async () => {
  const reports: unknown[] = [];
  const workbench = await testWorkbench(
    undefined,
    createMockBackend("policyFile"),
  );
  vi.spyOn(workbench, "report").mockImplementation((error) => {
    reports.push(error);
  });
  const { commands, keys, catalog } = workbench;
  await act(() => Promise.resolve());
  const source = catalog.find("prod-eu")?.access.source;
  expect(source?.kind).toBe("policyFile");

  await act(() =>
    commands.execute(SET_CONTEXT_MODE, keys.lookup(null), {
      context: "prod-eu",
      value: "read-write",
    }),
  );
  await act(() => commands.execute(UNLOCK_CONTEXT, keys.lookup(null)));
  expect(catalog.find("prod-eu")?.access.mode).toBe("read-only");
  expect(reports.length).toBe(2);
  for (const report of reports) {
    expect((report as Error).message).toContain("prod-*");
  }
});

test("the rail's menu sets the mode and the type of the space it names", async () => {
  const { commands, keys, catalog, quickAccess } = await testWorkbench();
  await act(() => Promise.resolve());
  const pickFrom = async (command: string, id: string) => {
    const run = commands.execute(command, keys.lookup(null), "dev");
    await act(() => Promise.resolve());
    const pick = quickAccess.session?.pick;
    act(() => {
      pick?.resolve(pick.items.find((item) => item.id === id));
    });
    await act(() => run);
  };
  await pickFrom(SET_CONTEXT_MODE, "read-only");
  expect(catalog.find("dev")?.access.mode).toBe("read-only");
  await pickFrom(SET_CONTEXT_ENVIRONMENT, "staging");
  expect(catalog.find("dev")?.access.environment).toBe("staging");
  expect(catalog.find("prod-eu")?.access.source).toEqual({
    kind: "environment",
    environment: "production",
  });
});

test("picking the guarded of an unlock in the palette leaves the unlock alone", async () => {
  const { commands, keys, catalog, quickAccess } = await testWorkbench();
  await act(() => Promise.resolve());
  await act(() => commands.execute(UNLOCK_CONTEXT, keys.lookup(null)));
  const until = catalog.find("prod-eu")?.access.unlockedUntil;
  const run = commands.execute(SET_CONTEXT_MODE, keys.lookup(null));
  await act(() => Promise.resolve());
  const pick = quickAccess.session?.pick;
  act(() => {
    pick?.resolve(pick.items.find((item) => item.id === "guarded"));
  });
  await act(() => run);
  const access = catalog.find("prod-eu")?.access;
  expect(access?.unlockedUntil).toBe(until);
  expect(access?.source).toEqual({
    kind: "environment",
    environment: "production",
  });
});

test("a person's None holds over a type from the kubeconfig's fixtures", async () => {
  const { commands, keys, catalog, colors } = await testWorkbench();
  await act(() => Promise.resolve());
  await act(() =>
    commands.execute(SET_CONTEXT_ENVIRONMENT, keys.lookup(null), {
      context: "kind-local",
      value: null,
    }),
  );
  expect(catalog.find("kind-local")?.access.environment).toBeNull();
  expect(colors.source("kind-local")).toBe("automatic");
});

test("the relock by itself reaches the context keys", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { commands, keys } = await testWorkbench();
  await act(() => Promise.resolve());
  await act(() => commands.execute(UNLOCK_CONTEXT, keys.lookup(null)));
  expect(keys.lookup(null)("context.unlocked")).toBe(true);
  await act(() => vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 10));
  expect(keys.lookup(null)("context.unlocked")).toBe(false);
  expect(keys.lookup(null)("context.readOnly")).toBe(true);
  vi.useRealTimers();
});

test("an unlocked context says what it goes back to", () => {
  const source = { kind: "environment", environment: "production" } as const;
  expect(
    describeAccess(access({ source, mode: "guarded", unlockedUntil: 1000 })),
  ).toBe(
    "You unlocked it for now; then it is read-only again. The default for Production.",
  );
  expect(describeAccess(access({ source, mode: "read-only" }))).toBe(
    "The default for Production.",
  );
});
