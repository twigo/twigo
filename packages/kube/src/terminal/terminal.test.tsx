import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Backend } from "@twigo/protocol";
import { createMockBackend, type MockScenario } from "@twigo/protocol/mock";
import { WorkbenchView, type Workbench } from "@twigo/workbench";
import { tabsIn, testWorkbench } from "@twigo/workbench/testing";
import { settle, withScreenSize } from "../../test/workbench";
import { withTerminalLayout } from "../../test/terminal";
import { terminalUri } from "../uri";
import { createTerminalTabs, registerTerminals } from "./register";
import type { TerminalTab, TerminalTabs } from "./tabs";

withScreenSize(1400);
withTerminalLayout();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
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
): Promise<Mounted> {
  const backend = createMockBackend(scenario);
  const workbench = await testWorkbench(scenario, backend, "mac");
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

test("Restart Terminal is enabled where the focus is in a terminal that ended, and nowhere else", async () => {
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
  await type(tab, "exit\r");
  expect(await restart()).toBe(1);
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
