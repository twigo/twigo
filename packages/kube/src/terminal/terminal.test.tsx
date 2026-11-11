import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Backend, Mode } from "@twigo/protocol";
import { createMockBackend, type MockScenario } from "@twigo/protocol/mock";
import { WorkbenchView, type Platform, type Workbench } from "@twigo/workbench";
import { tabsIn, testWorkbench } from "@twigo/workbench/testing";
import { settle, withScreenSize } from "../../test/workbench";
import { withTerminalLayout } from "../../test/terminal";
import { terminalUri } from "../uri";
import { workbenchKey } from "../xterm/keys";
import { createTerminalTabs, registerTerminals } from "./register";
import type { TerminalTab, TerminalTabs } from "./tabs";

withScreenSize(1400);
withTerminalLayout();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  history.replaceState(null, "", "/");
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

interface Mounted {
  readonly workbench: Workbench;
  readonly tabs: TerminalTabs;
  readonly backend: Backend;
  readonly press: () => Promise<boolean>;
  readonly create: () => Promise<void>;
}

async function mounted(
  scenario: MockScenario = "ready",
  space = "qa",
  platform: Platform = "mac",
): Promise<Mounted> {
  const backend = createMockBackend(scenario);
  const workbench = await testWorkbench(scenario, backend, platform);
  const tabs = createTerminalTabs(workbench);
  registerTerminals(workbench, tabs);
  await act(() => workbench.spaces.open(space));
  act(() => {
    workbench.spaces.select(space);
  });
  render(<WorkbenchView workbench={workbench} />);
  await settle();
  const press = () =>
    workbench.commands.execute("k8s.terminal.new", workbench.keys.lookup(null));
  return {
    workbench,
    tabs,
    backend,
    press,
    create: async () => {
      const run = press();
      await settle(10);
      await run;
    },
  };
}

const uriOf = (n: number, space = "qa") => terminalUri({ space, n });
const panelTabs = () => tabsIn("panel");

function text(tab: TerminalTab): string {
  const { active } = tab.term.buffer;
  const lines: string[] = [];
  for (let i = 0; i < active.length; i++) {
    const line = active.getLine(i);
    const row = line?.translateToString(true) ?? "";
    const last = lines.length - 1;
    if (line?.isWrapped === true && last >= 0) {
      lines[last] = `${lines[last] ?? ""}${row}`;
    } else {
      lines.push(row);
    }
  }
  return lines.join("\n");
}

function tabOf(tabs: TerminalTabs, n = 1, space = "qa"): TerminalTab {
  const tab = tabs.get(uriOf(n, space));
  if (!tab) throw new Error(`no terminal ${String(n)}`);
  return tab;
}

async function setMode(backend: Backend, context: string, mode: Mode) {
  await act(() => backend.invoke("context_mode_set", { context, mode }));
  await settle(4);
}

async function type(tab: TerminalTab, input: string): Promise<void> {
  act(() => {
    tab.term.input(input);
  });
  await settle(4);
}

test("New Terminal creates a terminal of the space's context, titled by its number, and its shell runs in the tab", async () => {
  const { workbench, tabs, backend, create } = await mounted();
  const invoke = vi.spyOn(backend, "invoke");
  await create();
  expect(
    invoke.mock.calls.find(([command]) => command === "terminal_create")?.[1],
  ).toEqual({ context: "qa", label: "Terminal 1" });
  expect(panelTabs()).toEqual([uriOf(1)]);
  expect(workbench.editors.title(uriOf(1))).toBe("Terminal 1");
  const tab = tabOf(tabs);
  expect(tab.kind).toEqual({ kind: "kubeconfig" });
  expect(tab.getStatus().state).toBe("running");
  expect(text(tab)).toContain("you@mac ~ %");
  expect(document.activeElement).toBe(tab.term.textarea);
});

test("a tab takes the first number its space has not, two quick presses included", async () => {
  const { workbench, tabs, press, create } = await mounted();
  const first = press();
  const second = press();
  await settle(10);
  await Promise.all([first, second]);
  expect(panelTabs().sort()).toEqual([uriOf(1), uriOf(2)]);

  act(() => {
    workbench.editors.close(uriOf(1));
  });
  await settle(4);
  expect(tabs.has(uriOf(1))).toBe(false);
  await create();
  expect(panelTabs().sort()).toEqual([uriOf(1), uriOf(2)]);
});

test("a terminal the core refuses is reported and opens no tab", async () => {
  const { workbench, backend, create } = await mounted();
  const report = vi.spyOn(workbench, "report");
  vi.spyOn(backend, "invoke").mockRejectedValue(new Error("no pty"));
  await create();
  expect(report).toHaveBeenCalledOnce();
  expect(panelTabs()).toEqual([]);
});

test("a tab the layout restored says its terminal ended when Twigo closed, runs nothing, and Restart creates a terminal at its URI", async () => {
  const { workbench, tabs, backend } = await mounted();
  const invoke = vi.spyOn(backend, "invoke");
  const subscribe = vi.spyOn(backend, "subscribe");
  const uri = uriOf(3);
  act(() => {
    workbench.editors.open(uri);
  });
  await settle(10);
  screen.getByText("This terminal ended when Twigo closed");
  const sessions = (calls: readonly (readonly unknown[])[]) =>
    calls
      .map(([command]) => String(command))
      .filter((command) => /^(shell_|terminal_)/.test(command));
  expect(sessions(invoke.mock.calls)).toEqual([]);
  expect(sessions(subscribe.mock.calls)).toEqual([]);
  expect(tabs.get(uri)?.kind).toBeUndefined();

  fireEvent.click(screen.getByRole("button", { name: "Restart" }));
  await settle(10);
  expect(
    invoke.mock.calls.find(([command]) => command === "terminal_create")?.[1],
  ).toEqual({ context: "qa", label: "Terminal 3" });
  expect(
    screen.queryByText("This terminal ended when Twigo closed"),
  ).toBeNull();
  expect(panelTabs()).toEqual([uri]);
  expect(tabs.get(uri)?.getStatus().state).toBe("running");
});

test("a tab closed while Restart waits for the core stays closed, and the session the core answers with is closed", async () => {
  const { workbench, tabs, backend } = await mounted();
  const original = backend.invoke.bind(backend);
  let answer: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const created: number[] = [];
  const closed: unknown[] = [];
  vi.spyOn(backend, "invoke").mockImplementation(
    async (command: string, request: unknown) => {
      if (command === "shell_close") closed.push(request);
      if (command !== "terminal_create") {
        return original(command as never, request as never);
      }
      await gate;
      const session = await original(command, request as never);
      created.push(session.id);
      return session;
    },
  );
  const uri = uriOf(3);
  act(() => {
    workbench.editors.open(uri);
  });
  await settle(10);
  fireEvent.click(screen.getByRole("button", { name: "Restart" }));
  await settle(4);
  act(() => {
    workbench.editors.close(uri);
  });
  await settle(4);
  answer();
  await settle(10);

  expect(panelTabs()).toEqual([]);
  expect(tabs.has(uri)).toBe(false);
  expect(created).toHaveLength(1);
  expect(closed).toEqual(created);
});

test("Restart on an ended terminal starts a new session in the same tab, keeping what it showed, and the core decides its kind again", async () => {
  const { tabs, backend, create } = await mounted();
  await create();
  const tab = tabOf(tabs);
  expect(tab.kind).toEqual({ kind: "kubeconfig" });
  await type(tab, "echo first\r");
  await type(tab, "exit 4\r");
  expect(tab.getStatus()).toEqual({
    state: "ended",
    end: { reason: "exited", code: 4 },
  });
  screen.getByText("Exit 4");

  await act(() =>
    backend.invoke("context_mode_set", { context: "qa", mode: "guarded" }),
  );
  const invoke = vi.spyOn(backend, "invoke");
  fireEvent.click(screen.getByRole("button", { name: "Restart Terminal" }));
  await settle(10);
  expect(tabs.get(uriOf(1))).toBe(tab);
  expect(tab.getStatus().state).toBe("running");
  expect(tab.kind).toEqual({ kind: "proxy", why: "mode" });
  expect(invoke.mock.calls.map(([command]) => command)).toContain(
    "terminal_create",
  );
  expect(text(tab)).toContain("first");
  expect(text(tab)).toContain("Session ended with exit code 4.");
});

test("a shell killed by a signal says which in the tab and in the scrollback", async () => {
  const { tabs, create } = await mounted();
  await create();
  const tab = tabOf(tabs);
  await type(tab, "kill -9 $$\r");
  screen.getByText("SIGKILL");
  expect(text(tab)).toContain("Session ended by SIGKILL.");
  screen.getByRole("button", { name: "Restart Terminal" });
});

test("a running terminal offers no Restart", async () => {
  const { create } = await mounted();
  await create();
  expect(screen.queryByRole("button", { name: "Restart Terminal" })).toBeNull();
});

test("Restart Terminal is enabled where the focus is in a terminal that ended or that holds real credentials on a context that is not read-write, and nowhere else", async () => {
  const { workbench, tabs, backend, create } = await mounted();
  await create();
  const tab = tabOf(tabs);
  const invoke = vi.spyOn(backend, "invoke");
  const restart = async () => {
    await workbench.commands.execute(
      "k8s.terminal.restart",
      workbench.keys.lookup(document.activeElement),
      { uri: uriOf(1) },
    );
    await settle(6);
    return invoke.mock.calls.filter(([c]) => c === "terminal_create").length;
  };
  expect(await restart()).toBe(0);
  await setMode(backend, "qa", "guarded");
  expect(await restart()).toBe(1);
  expect(tab.kind).toEqual({ kind: "proxy", why: "mode" });
  expect(await restart()).toBe(1);
  await type(tab, "exit\r");
  expect(await restart()).toBe(2);
});

test("the terminal of a space is the space's own: a staging terminal asks the core for staging", async () => {
  const { workbench, tabs, backend } = await mounted("ready", "qa");
  await act(() => workbench.spaces.open("staging"));
  act(() => {
    workbench.spaces.select("staging");
  });
  await settle(6);
  const invoke = vi.spyOn(backend, "invoke");
  const run = workbench.commands.execute(
    "k8s.terminal.new",
    workbench.keys.lookup(null),
  );
  await settle(10);
  await run;
  expect(
    invoke.mock.calls.find(([command]) => command === "terminal_create")?.[1],
  ).toEqual({ context: "staging", label: "Terminal 1" });
  expect(tabs.get(uriOf(1, "staging"))?.kind).toEqual({
    kind: "proxy",
    why: "mode",
  });
});

const BACKQUOTE = { key: "`", code: "Backquote" };

function keydown(target: Element, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...BACKQUOTE,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

async function press(
  target: Element,
  init: KeyboardEventInit,
): Promise<boolean> {
  const event = keydown(target, init);
  await settle(10);
  return event.defaultPrevented;
}

const TOGGLE = { ctrlKey: true };
const NEW = { ctrlKey: true, shiftKey: true };
const panelShown = (workbench: Workbench) =>
  workbench.spaces.state("qa").parts.panel.visible;

test("Toggle Terminal with no terminal in the space starts one and shows the panel with it focused", async () => {
  const { workbench, tabs } = await mounted();
  expect(panelShown(workbench)).toBe(false);
  expect(await press(document.body, TOGGLE)).toBe(true);
  expect(panelTabs()).toEqual([uriOf(1)]);
  expect(panelShown(workbench)).toBe(true);
  expect(document.activeElement).toBe(tabOf(tabs).term.textarea);
});

test("Toggle Terminal shows the panel with the terminal that was last in use, and starts none when there is one", async () => {
  const { workbench, tabs, create } = await mounted();
  await create();
  await create();
  act(() => {
    workbench.editors.open(uriOf(1));
  });
  await settle(4);
  act(() => {
    workbench.spaces.setPart("qa", "panel", { visible: false });
  });
  await settle(4);
  expect(panelShown(workbench)).toBe(false);

  await press(document.body, TOGGLE);
  expect(panelShown(workbench)).toBe(true);
  expect(panelTabs().sort()).toEqual([uriOf(1), uriOf(2)]);
  expect(workbench.editors.activeIn("panel")).toBe(uriOf(1));
  expect(document.activeElement).toBe(tabOf(tabs, 1).term.textarea);
});

function withNote(workbench: Workbench) {
  workbench.editors.register({
    id: "test.note",
    scheme: "note",
    area: "panel",
    title: (uri) => uri.host,
    component: ({ uri }) => <p>note {uri}</p>,
  });
}

test("Toggle Terminal shows a terminal the layout restored behind another tab, and starts none", async () => {
  const { workbench, tabs, backend } = await mounted();
  withNote(workbench);
  const invoke = vi.spyOn(backend, "invoke");
  act(() => {
    workbench.editors.open(uriOf(1));
    workbench.editors.open("note://a");
  });
  await settle(6);
  act(() => {
    workbench.spaces.setPart("qa", "panel", { visible: false });
  });
  await settle(4);
  expect(workbench.editors.activeIn("panel")).toBe("note://a");

  await press(document.body, TOGGLE);
  expect(invoke.mock.calls.map(([command]) => command)).not.toContain(
    "terminal_create",
  );
  expect(panelTabs().sort()).toEqual(["note://a", uriOf(1)]);
  expect(panelShown(workbench)).toBe(true);
  expect(workbench.editors.activeIn("panel")).toBe(uriOf(1));
  expect(tabs.has(uriOf(2))).toBe(false);
});

test("Toggle Terminal hides the panel where a terminal has the focus, and focuses the terminal where something else has it", async () => {
  const { workbench, tabs, create } = await mounted();
  await create();
  const { textarea } = tabOf(tabs).term;
  if (!textarea) throw new Error("no terminal");
  expect(document.activeElement).toBe(textarea);

  await press(textarea, TOGGLE);
  expect(panelShown(workbench)).toBe(false);

  act(() => {
    workbench.spaces.setPart("qa", "panel", { visible: true });
  });
  await settle(4);
  act(() => {
    (document.activeElement as HTMLElement).blur();
  });
  expect(document.activeElement).toBe(document.body);
  await press(document.body, TOGGLE);
  expect(panelShown(workbench)).toBe(true);
  expect(document.activeElement).toBe(textarea);
  expect(panelTabs()).toEqual([uriOf(1)]);
});

test("Toggle Terminal over a terminal the layout restored focuses its view, so a second press hides the panel", async () => {
  const { workbench, tabs } = await mounted();
  act(() => {
    workbench.editors.open(uriOf(1));
  });
  await settle(10);
  act(() => {
    workbench.spaces.setPart("qa", "panel", { visible: false });
  });
  await settle(4);
  expect(tabs.get(uriOf(1))?.getStatus().state).toBe("restored");

  await press(document.body, TOGGLE);
  expect(panelShown(workbench)).toBe(true);
  expect(workbench.keys.lookup(document.activeElement)("terminalFocus")).toBe(
    true,
  );

  await press(document.activeElement ?? document.body, TOGGLE);
  expect(panelShown(workbench)).toBe(false);
});

test("New Terminal is on Ctrl+Shift+` and starts another terminal, from a terminal too", async () => {
  const { tabs, create } = await mounted();
  await create();
  const { textarea } = tabOf(tabs).term;
  if (!textarea) throw new Error("no terminal");
  expect(await press(textarea, NEW)).toBe(true);
  expect(panelTabs().sort()).toEqual([uriOf(1), uriOf(2)]);
});

test.each<Platform>(["mac", "linux"])(
  "on %s the terminal's own keys win over the shell, and the other Ctrl chords stay with it",
  async (platform) => {
    const { workbench, tabs, create } = await mounted("ready", "qa", platform);
    await create();
    const { textarea } = tabOf(tabs).term;
    if (!textarea) throw new Error("no terminal");
    const binds = (init: KeyboardEventInit) =>
      workbenchKey(
        workbench.keybindings,
        platform,
        keydown(textarea, { ...init }),
      );
    expect(binds(TOGGLE)).toBe(true);
    expect(binds(NEW)).toBe(true);
    expect(binds({ key: "c", code: "KeyC", ctrlKey: true })).toBe(false);
    expect(binds({})).toBe(false);
  },
);

test("where ` needs Shift, as on the recorded German layout, the two terminal keys are one chord that Toggle takes, and New Terminal stays in the palette with no key beside it", async () => {
  const { workbench, tabs } = await mounted();
  workbench.keybindings.setLayout(
    await createMockBackend("ready", "german").subscribe(
      "keyboard_layout_watch",
      null,
      () => undefined,
    ),
  );
  const chord = { key: "`", code: "Equal", ctrlKey: true, shiftKey: true };
  expect(workbench.keybindings.primary("k8s.terminal.new")).toBeUndefined();
  expect(
    workbench.keybindings.primary("k8s.terminal.toggle")?.ids,
  ).toHaveLength(1);

  await press(document.body, chord);
  expect(panelTabs()).toEqual([uriOf(1)]);
  await press(document.activeElement ?? document.body, chord);
  expect(panelTabs()).toEqual([uriOf(1)]);
  expect(panelShown(workbench)).toBe(false);
  expect(tabs.has(uriOf(2))).toBe(false);

  const items = await workbench.quickAccess
    .resolve(">")
    ?.provider.items("", { lookup: workbench.keys.lookup(document.body) });
  const keyOf = (id: string) =>
    items?.find((item) => item.id === id)?.keybinding;
  expect(items?.map(({ id }) => id)).toContain("k8s.terminal.new");
  expect(keyOf("k8s.terminal.new")).toBeUndefined();
  expect(keyOf("k8s.terminal.toggle")).toBeDefined();
});

test.each<[Platform, boolean]>([
  ["mac", false],
  ["linux", true],
])(
  "on %s a Ctrl binding of quick access, the palette or the panel's toggle is taken from the shell: %s",
  async (platform, taken) => {
    const { workbench, tabs, create } = await mounted("ready", "qa", platform);
    await create();
    const { textarea } = tabOf(tabs).term;
    if (!textarea) throw new Error("no terminal");
    const bound = [
      ["KeyQ", "workbench.action.quickOpen"],
      ["KeyW", "workbench.action.showCommands"],
      ["KeyE", "workbench.action.togglePanel"],
    ] as const;
    workbench.keybindings.register(
      "user",
      bound.map(([code, command]) => ({
        key: `ctrl+shift+${code.slice(3).toLowerCase()}`,
        command,
      })),
    );
    for (const [code] of bound) {
      const event = keydown(textarea, {
        key: code.slice(3).toLowerCase(),
        code,
        ctrlKey: true,
        shiftKey: true,
      });
      expect(workbenchKey(workbench.keybindings, platform, event)).toBe(taken);
    }
  },
);

async function pick(workbench: Workbench, id?: string) {
  const asking = workbench.quickAccess.session?.pick;
  if (!asking) throw new Error("nothing asks");
  act(() => {
    asking.resolve(asking.items.find((item) => item.id === id));
  });
  await settle(6);
}

test("Go to Terminal… and Close Terminal… list the space's terminals with the state of those that ended", async () => {
  const { workbench, tabs, create } = await mounted();
  await create();
  await create();
  await type(tabOf(tabs, 2), "exit 1\r");
  const lookup = workbench.keys.lookup(null);

  const go = workbench.commands.execute("k8s.terminal.show", lookup);
  await settle(4);
  const asking = workbench.quickAccess.session?.pick;
  expect(
    asking?.items.map(({ id, label, state }) => [id, label, state?.label]),
  ).toEqual([
    [uriOf(1), "Terminal 1", undefined],
    [uriOf(2), "Terminal 2", "Exit 1"],
  ]);
  await pick(workbench, uriOf(1));
  await go;
  expect(workbench.editors.activeIn("panel")).toBe(uriOf(1));

  const close = workbench.commands.execute("k8s.terminal.close", lookup);
  await settle(4);
  await pick(workbench, uriOf(2));
  await close;
  expect(panelTabs()).toEqual([uriOf(1)]);
  expect(tabs.has(uriOf(2))).toBe(false);

  act(() => {
    workbench.editors.close(uriOf(1));
  });
  await settle(4);
  expect(workbench.commands.enabled("k8s.terminal.show", lookup)).toBe(false);
});

test("the picks list only the terminals of the space that shows, and wait for a terminal to exist", async () => {
  const { workbench, tabs, create } = await mounted();
  const lookup = () => workbench.keys.lookup(null);
  expect(workbench.commands.enabled("k8s.terminal.show", lookup())).toBe(false);
  await create();
  await act(() => workbench.spaces.open("staging"));
  act(() => {
    workbench.spaces.select("staging");
  });
  await settle(6);
  const run = workbench.commands.execute("k8s.terminal.new", lookup());
  await settle(10);
  await run;
  expect(tabs.has(uriOf(1, "staging"))).toBe(true);
  const go = workbench.commands.execute("k8s.terminal.show", lookup());
  await settle(4);
  expect(
    workbench.quickAccess.session?.pick?.items.map(({ id }) => id),
  ).toEqual([uriOf(1, "staging")]);
  await pick(workbench);
  await go;
});

async function restarted(
  layout: ReturnType<Workbench["spaces"]["state"]>["panelEditors"],
) {
  const backend = createMockBackend("ready");
  const workbench = await testWorkbench("ready", backend, "mac");
  const tabs = createTerminalTabs(workbench);
  registerTerminals(workbench, tabs);
  withNote(workbench);
  await act(() => workbench.spaces.open("qa"));
  act(() => {
    workbench.spaces.select("qa");
    workbench.spaces.update("qa", (state) => ({
      ...state,
      panelEditors: layout,
    }));
  });
  render(<WorkbenchView workbench={workbench} />);
  await settle(10);
  return { workbench, tabs };
}

test("after a restart the terminals restored behind another panel tab are in the tabs that Toggle, Go to and Close read, the hidden panel too", async () => {
  const first = await mounted();
  withNote(first.workbench);
  act(() => {
    first.workbench.editors.open(uriOf(1));
    first.workbench.editors.open(uriOf(2));
    first.workbench.editors.open("note://a");
  });
  await settle(6);
  const layout = first.workbench.spaces.state("qa").panelEditors;
  cleanup();

  const { workbench, tabs } = await restarted(layout);
  expect(panelShown(workbench)).toBe(false);
  expect(workbench.editors.activeIn("panel")).toBe("note://a");
  expect(tabs.list().map(([uri]) => uri)).toEqual([uriOf(1), uriOf(2)]);
  expect(tabs.get(uriOf(1))?.getStatus().state).toBe("restored");

  const invoke = vi.spyOn(workbench.backend, "invoke");
  await press(document.body, TOGGLE);
  expect(invoke.mock.calls.map(([command]) => command)).not.toContain(
    "terminal_create",
  );
  expect(panelShown(workbench)).toBe(true);
  expect(workbench.editors.activeIn("panel")).toBe(uriOf(1));

  const lookup = workbench.keys.lookup(null);
  const go = workbench.commands.execute("k8s.terminal.show", lookup);
  await settle(4);
  expect(
    workbench.quickAccess.session?.pick?.items.map(({ id }) => id),
  ).toEqual([uriOf(1), uriOf(2)]);
  await pick(workbench, uriOf(2));
  await go;
  expect(workbench.editors.activeIn("panel")).toBe(uriOf(2));

  const close = workbench.commands.execute("k8s.terminal.close", lookup);
  await settle(4);
  expect(
    workbench.quickAccess.session?.pick?.items.map(({ id }) => id),
  ).toEqual([uriOf(1), uriOf(2)]);
  await pick(workbench, uriOf(1));
  await close;
  expect(tabs.has(uriOf(1))).toBe(false);
});

const tabStrip = () => {
  const panel = document.querySelector('[aria-label="Panel"]');
  if (!panel) throw new Error("no panel");
  return panel;
};

const tabIcon = (uri: string) =>
  tabStrip().querySelector(`[data-tab-panel-id="${uri}"] svg`)?.classList;

test("the kind is a chip beside the state, and the warning turns it to warn with Restart beside it", async () => {
  const { workbench, backend, create } = await mounted("ready", "dev");
  await create();
  screen.getByText("Your credentials");
  expect(screen.queryByRole("button", { name: "Restart Terminal" })).toBeNull();
  expect(tabIcon(uriOf(1, "dev"))).toContain("lucide-terminal");

  await setMode(backend, "dev", "read-only");
  screen.getByText("Your credentials · read-only context");
  fireEvent.click(screen.getByRole("button", { name: "Restart Terminal" }));
  await settle(10);
  screen.getByText("Proxy · read-only");
  expect(screen.queryByRole("button", { name: "Restart Terminal" })).toBeNull();
  expect(workbench.editors.activeIn("panel")).toBe(uriOf(1, "dev"));
});

test("the chip says the proxy and the mode of a guarded context, and follows the mode", async () => {
  const { backend, create } = await mounted("ready", "staging");
  await create();
  screen.getByText("Proxy · guarded");
  await setMode(backend, "staging", "read-only");
  screen.getByText("Proxy · read-only");
  expect(screen.queryByRole("button", { name: "Restart Terminal" })).toBeNull();
});

test("the kind is the chip and nothing else, whatever the address asks for", async () => {
  history.replaceState(null, "", "/?variant=kind:line");
  const { backend, create } = await mounted("ready", "dev");
  await create();
  const uri = uriOf(1, "dev");
  screen.getByText("Your credentials");
  expect(screen.queryByText("Your credentials.")).toBeNull();
  expect(tabIcon(uri)).toContain("lucide-terminal");

  history.replaceState(null, "", "/?variant=kind:icon");
  await setMode(backend, "dev", "guarded");
  screen.getByText("Your credentials · guarded context");
  expect(
    screen.queryByText("Holds your real credentials, and dev is guarded now."),
  ).toBeNull();
  expect(tabIcon(uri)).toContain("lucide-terminal");
});

test("a tab nothing started says no kind", async () => {
  const { workbench } = await mounted("ready", "dev");
  act(() => {
    workbench.editors.open(uriOf(1, "dev"));
  });
  await settle(10);
  screen.getByText("This terminal ended when Twigo closed");
  expect(screen.queryByText("Your credentials")).toBeNull();
});
