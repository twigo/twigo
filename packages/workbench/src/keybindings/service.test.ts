import { afterEach, expect, test, vi } from "vitest";
import { Commands } from "../commands/registry";
import { ContextKeys } from "../contextkey/service";
import { Keybindings } from "./service";

afterEach(() => {
  document.body.replaceChildren();
});

function setup() {
  const onError = vi.fn();
  const commands = new Commands(onError);
  const keys = new ContextKeys();
  const keybindings = new Keybindings(
    commands,
    keys,
    { id: "us", keys: {} },
    "mac",
  );
  const ran: string[] = [];
  for (const id of ["palette", "keybindings", "logs", "fails"]) {
    commands.register({
      id,
      title: id,
      category: "Test",
      run: () => {
        if (id === "fails") throw new Error("boom");
        ran.push(id);
      },
    });
  }
  keybindings.register("core", [
    { key: "mod+shift+p", command: "palette" },
    { key: "mod+k mod+s", command: "keybindings" },
    { key: "l", command: "logs" },
    { key: "mod+e", command: "fails" },
  ]);
  return { commands, keys, keybindings, ran, onError };
}

function key(
  code: string,
  init: KeyboardEventInit = {},
  target: Element = document.body,
) {
  const event = new KeyboardEvent("keydown", {
    code,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

function byId(id: string) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`no #${id}`);
  return element;
}

async function settle() {
  await Promise.resolve();
}

test("a bound key runs its command and is consumed", async () => {
  const { keybindings, ran } = setup();
  document.addEventListener("keydown", (event) => keybindings.dispatch(event), {
    once: true,
  });
  const event = key("KeyP", { metaKey: true, shiftKey: true });
  await settle();
  expect(ran).toEqual(["palette"]);
  expect(event.defaultPrevented).toBe(true);
});

test("an unbound key passes through", () => {
  const { keybindings } = setup();
  const event = new KeyboardEvent("keydown", {
    code: "KeyP",
    metaKey: true,
    cancelable: true,
  });
  expect(keybindings.dispatch(event)).toBe(false);
  expect(event.defaultPrevented).toBe(false);
});

test("a chord waits, shows as pending, then runs", async () => {
  const { keybindings, ran } = setup();
  const changes = vi.fn();
  keybindings.changes.subscribe(changes);
  const first = new KeyboardEvent("keydown", {
    code: "KeyK",
    metaKey: true,
    cancelable: true,
  });
  expect(keybindings.dispatch(first)).toBe(true);
  expect(keybindings.label(keybindings.pending)).toBe("⌘K");
  const second = new KeyboardEvent("keydown", {
    code: "KeyS",
    metaKey: true,
    cancelable: true,
  });
  expect(keybindings.dispatch(second)).toBe(true);
  await settle();
  expect(ran).toEqual(["keybindings"]);
  expect(keybindings.pending).toEqual([]);
  expect(changes).toHaveBeenCalledTimes(2);
});

test("a key that continues no chord ends it and is swallowed", () => {
  const { keybindings, ran } = setup();
  keybindings.dispatch(
    new KeyboardEvent("keydown", { code: "KeyK", metaKey: true }),
  );
  const stray = new KeyboardEvent("keydown", {
    code: "KeyX",
    cancelable: true,
  });
  expect(keybindings.dispatch(stray)).toBe(true);
  expect(stray.defaultPrevented).toBe(true);
  expect(keybindings.pending).toEqual([]);
  expect(ran).toEqual([]);
});

test("modifier presses do not break a chord", async () => {
  const { keybindings, ran } = setup();
  keybindings.dispatch(
    new KeyboardEvent("keydown", { code: "KeyK", metaKey: true }),
  );
  expect(
    keybindings.dispatch(
      new KeyboardEvent("keydown", { code: "MetaLeft", metaKey: true }),
    ),
  ).toBe(false);
  keybindings.dispatch(
    new KeyboardEvent("keydown", { code: "KeyS", metaKey: true }),
  );
  await settle();
  expect(ran).toEqual(["keybindings"]);
});

test("a bare key fires in a focused list and not in its filter input", async () => {
  const { keybindings, keys, ran } = setup();
  document.body.innerHTML = `<div id="list" tabindex="0"><input id="filter" /></div>`;
  const list = byId("list");
  keys.scope(list).set("listFocus", true);
  document.addEventListener("keydown", (event) => keybindings.dispatch(event), {
    once: true,
  });
  key("KeyL", {}, list);
  await settle();
  expect(ran).toEqual(["logs"]);
  const typed = new KeyboardEvent("keydown", {
    code: "KeyL",
    bubbles: true,
    cancelable: true,
  });
  byId("filter").dispatchEvent(typed);
  expect(keybindings.dispatch(typed)).toBe(false);
});

test("an event a component already handled is left alone", () => {
  const { keybindings } = setup();
  const event = new KeyboardEvent("keydown", {
    code: "KeyP",
    metaKey: true,
    shiftKey: true,
    cancelable: true,
  });
  event.preventDefault();
  expect(keybindings.dispatch(event)).toBe(false);
});

test("IME composition is left alone", () => {
  const { keybindings } = setup();
  const event = new KeyboardEvent("keydown", {
    code: "KeyP",
    metaKey: true,
    shiftKey: true,
    isComposing: true,
  });
  expect(keybindings.dispatch(event)).toBe(false);
});

test("a failing command reaches onError", async () => {
  const { keybindings, onError } = setup();
  keybindings.dispatch(
    new KeyboardEvent("keydown", { code: "KeyE", metaKey: true }),
  );
  await settle();
  await settle();
  expect(onError).toHaveBeenCalledWith("fails", new Error("boom"));
});

test("a user binding added later overrides and can be removed again", async () => {
  const { keybindings, ran } = setup();
  const remove = keybindings.register("user", [
    { key: "mod+shift+p", command: "logs" },
  ]);
  keybindings.dispatch(
    new KeyboardEvent("keydown", {
      code: "KeyP",
      metaKey: true,
      shiftKey: true,
    }),
  );
  remove();
  keybindings.dispatch(
    new KeyboardEvent("keydown", {
      code: "KeyP",
      metaKey: true,
      shiftKey: true,
    }),
  );
  await settle();
  expect(ran).toEqual(["logs", "palette"]);
});

test("a new layout moves the bindings", async () => {
  const { keybindings, ran } = setup();
  keybindings.setLayout({
    id: "dvorak",
    keys: {
      KeyR: { value: "p", withShift: "P", withAltGr: "", withShiftAltGr: "" },
    },
  });
  keybindings.dispatch(
    new KeyboardEvent("keydown", {
      code: "KeyR",
      metaKey: true,
      shiftKey: true,
    }),
  );
  await settle();
  expect(ran).toEqual(["palette"]);
  expect(keybindings.label(keybindings.primary("palette")?.presses ?? [])).toBe(
    "⇧⌘P",
  );
});

test("handles says which keys are the workbench's without running one", () => {
  const { keybindings, ran } = setup();
  const press = (code: string, init: KeyboardEventInit = {}) =>
    new KeyboardEvent("keydown", { code, cancelable: true, ...init });
  expect(
    keybindings.handles(press("KeyP", { metaKey: true, shiftKey: true })),
  ).toBe(true);
  expect(keybindings.handles(press("KeyP", { ctrlKey: true }))).toBe(false);
  expect(keybindings.handles(press("KeyC", { metaKey: true }))).toBe(false);
  expect(keybindings.handles(press("ShiftLeft", { shiftKey: true }))).toBe(
    false,
  );
  expect(ran).toEqual([]);
});

test("handles holds for the key that goes on a chord, and for the one that breaks it", () => {
  const { keybindings } = setup();
  const press = (code: string, init: KeyboardEventInit = {}) =>
    new KeyboardEvent("keydown", { code, cancelable: true, ...init });
  expect(keybindings.handles(press("KeyK", { metaKey: true }))).toBe(true);
  keybindings.dispatch(press("KeyK", { metaKey: true }));
  expect(keybindings.handles(press("KeyS", { metaKey: true }))).toBe(true);
  expect(keybindings.handles(press("KeyX"))).toBe(true);
});
