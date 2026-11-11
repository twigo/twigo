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
import { notify } from "@twigo/ui";
import { WorkbenchView, type Platform, type Workbench } from "@twigo/workbench";
import {
  click,
  stripOf,
  tabOf as tabElement,
  tabsIn,
  testWorkbench,
} from "@twigo/workbench/testing";
import { settle, withScreenSize } from "../../test/workbench";
import { ctrlC, withTerminalLayout } from "../../test/terminal";
import { execUri, objectUri, type ExecInput } from "../uri";
import { registerKube } from "../register";
import { createExecTabs, registerExec } from "./register";
import { ExecTabs, type WebglRenderer } from "./tabs";

withScreenSize(1400);
withTerminalLayout();

const NAMESPACE = "auth";
const POD = "auth-api-1p2si70-e9vxn";
const PODS = { group: "", version: "v1", resource: "pods" };
const FIRST: Record<string, string> = {
  qa: POD,
  staging: "auth-api-171gnye-q7vjw",
  "prod-eu": "auth-api-1a4uyl1-r2bkk",
};
const ONE = { container: "api" };
const RUNNING: ExecInput = {
  space: "qa",
  namespace: NAMESPACE,
  pod: POD,
  container: "api",
};

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
  readonly tabs: ExecTabs;
  readonly backend: Backend;
  readonly start: (
    space: string,
    more?: Record<string, unknown>,
  ) => Promise<boolean>;
  readonly open: (
    space: string,
    more?: Record<string, unknown>,
  ) => Promise<void>;
}

async function mounted(
  scenario: MockScenario = "ready",
  webgl?: () => WebglRenderer,
  platform: Platform = "mac",
): Promise<Mounted> {
  const backend = createMockBackend(scenario);
  const workbench = await testWorkbench(scenario, backend, platform);
  const tabs = webgl
    ? new ExecTabs({
        backend,
        platform: workbench.platform,
        report: (error) => {
          workbench.report(error);
        },
        openUrl: () => undefined,
        binds: () => false,
        webgl,
      })
    : createExecTabs(workbench);
  registerExec(workbench, tabs);
  await act(() => workbench.spaces.open("qa"));
  act(() => {
    workbench.spaces.select("qa");
  });
  render(<WorkbenchView workbench={workbench} />);
  await settle();
  return {
    workbench,
    tabs,
    backend,
    start: (space, more = {}) =>
      workbench.commands.execute(
        "k8s.shell.open",
        workbench.keys.lookup(null),
        {
          space,
          gvr: PODS,
          namespace: NAMESPACE,
          name: FIRST[space] ?? POD,
          ...more,
        },
      ),
    open: async (space, more = {}) => {
      const run = workbench.commands.execute(
        "k8s.shell.open",
        workbench.keys.lookup(null),
        {
          space,
          gvr: PODS,
          namespace: NAMESPACE,
          name: FIRST[space] ?? POD,
          ...more,
        },
      );
      await settle(10);
      await run;
    },
  };
}
async function pick(workbench: Workbench, id?: string) {
  const asking = workbench.quickAccess.session?.pick;
  if (!asking) throw new Error("nothing asks");
  act(() => {
    asking.resolve(asking.items.find((item) => item.id === id));
  });
  await settle(6);
}

const panelTabs = () => tabsIn("panel");

test("a shell asks which container when several run, the default first, and opens its tab with the session", async () => {
  const { workbench, tabs, start } = await mounted();
  const run = start("qa");
  await settle(4);
  const asking = workbench.quickAccess.session?.pick;
  expect(asking?.items.map(({ id, description }) => [id, description])).toEqual(
    [
      ["api", "default"],
      ["istio-proxy", undefined],
    ],
  );
  await pick(workbench, "istio-proxy");
  await run;
  const uri = execUri({ ...RUNNING, container: "istio-proxy" });
  expect(panelTabs()).toEqual([uri]);
  expect(workbench.editors.title(uri)).toBe(`${POD} · istio-proxy`);
  expect(tabs.get(uri)?.getStatus().state).toMatch(/^(connecting|running)$/);
});

test("the container the pod names as its default comes first in the picker, the others in their order", async () => {
  const { workbench, start } = await mounted("shellDefaultSecond");
  const run = start("qa");
  await settle(4);
  const asking = workbench.quickAccess.session?.pick;
  expect(asking?.items.map(({ id, description }) => [id, description])).toEqual(
    [
      ["istio-proxy", "default"],
      ["api", undefined],
    ],
  );
  await pick(workbench);
  await run;
});

test("a cancelled picker opens no tab and plans nothing", async () => {
  const { workbench, tabs, backend, start } = await mounted();
  const invoke = vi.spyOn(backend, "invoke");
  const run = start("qa");
  await settle(4);
  await pick(workbench);
  await run;
  expect(panelTabs()).toEqual([]);
  expect(tabs.list()).toEqual([]);
  expect(invoke.mock.calls.map(([command]) => command)).toEqual([
    "shell_containers",
  ]);
});

test("a pod with one container opens at once, and an attach is its own tab", async () => {
  const { tabs, open, workbench } = await mounted("shellOneContainer");
  await open("qa", ONE);
  await open("qa", { ...ONE, kind: "attach" });
  expect(panelTabs()).toEqual([
    execUri(RUNNING),
    execUri({ ...RUNNING, attach: true }),
  ]);
  expect(workbench.quickAccess.session).toBeUndefined();
  expect(tabs.get(execUri({ ...RUNNING, attach: true }))?.input.attach).toBe(
    true,
  );
});

test("a pod that runs nothing is reported in words and opens no tab", async () => {
  const { workbench, open } = await mounted("shellOneContainer");
  const report = vi.spyOn(workbench, "report");
  await open("qa", {
    name: "batch-indexer-p30d69-rylld",
    namespace: "batch",
    ...ONE,
  });
  await settle(4);
  expect(report).toHaveBeenCalledOnce();
  expect(panelTabs()).toEqual([]);
});

test("a read-only context refuses the plan, offers the unlock and opens no tab", async () => {
  const { workbench, open } = await mounted("shellOneContainer");
  const error = vi.spyOn(notify, "error");
  await act(() => workbench.spaces.open("prod-eu"));
  await open("prod-eu", ONE);
  await settle(4);
  expect(panelTabs()).toEqual([]);
  const [message, options] = error.mock.calls[0] ?? [];
  expect(message).toMatch(
    /prod-eu is read-only .*create pods\/auth-api-1a4uyl1-r2bkk\/exec in auth/,
  );
  expect(options?.action?.label).toBe("Unlock for 15 minutes");
});

test("a guarded context asks to confirm a shell, and a cancel opens nothing", async () => {
  const { workbench, tabs, start } = await mounted("shellOneContainer");
  await act(() => workbench.spaces.open("staging"));
  const first = start("staging", ONE);
  await settle(4);
  const asking = workbench.operations.asking;
  expect(asking?.plan.friction).toEqual({ kind: "confirm" });
  expect(asking?.plan.confirm).toBe("Open shell");
  act(() => {
    asking?.cancel();
  });
  await first;
  await settle(4);
  expect(panelTabs()).toEqual([]);
  expect(tabs.list()).toEqual([]);

  const second = start("staging", ONE);
  await settle(4);
  act(() => {
    workbench.operations.asking?.confirm(undefined);
  });
  await second;
  await settle(6);
  expect(panelTabs()).toEqual([
    execUri({ ...RUNNING, space: "staging", pod: FIRST.staging ?? POD }),
  ]);
});

test("a second shell on a container opens another tab", async () => {
  const fresh = await mounted("shellOneContainer");
  await fresh.open("qa", ONE);
  await fresh.open("qa", ONE);
  expect(panelTabs()).toEqual([
    execUri(RUNNING),
    execUri({ ...RUNNING, n: 2 }),
  ]);
});

test("two quick presses on a container make two tabs, and neither closes the other's session", async () => {
  const { backend, start } = await mounted("shellOneContainer");
  const invoke = vi.spyOn(backend, "invoke");
  const first = start("qa", ONE);
  const second = start("qa", ONE);
  await settle(10);
  await Promise.all([first, second]);
  await settle(10);
  expect(panelTabs()).toEqual([
    execUri(RUNNING),
    execUri({ ...RUNNING, n: 2 }),
  ]);
  expect(invoke.mock.calls.filter(([c]) => c === "shell_close")).toEqual([]);
});

test("a cancelled plan frees its place for the next press", async () => {
  const { workbench, start } = await mounted("shellOneContainer");
  await act(() => workbench.spaces.open("staging"));
  const first = start("staging", ONE);
  await settle(4);
  act(() => {
    workbench.operations.asking?.cancel();
  });
  await first;
  const second = start("staging", ONE);
  await settle(4);
  act(() => {
    workbench.operations.asking?.confirm(undefined);
  });
  await second;
  await settle(6);
  expect(panelTabs()).toEqual([
    execUri({ ...RUNNING, space: "staging", pod: FIRST.staging ?? POD }),
  ]);
});

async function planAway() {
  const mount = await mounted("shellOneContainer");
  const { workbench, start } = mount;
  await act(() => workbench.spaces.open("staging"));
  await act(() => workbench.spaces.open("prod-eu"));
  act(() => {
    workbench.spaces.select("staging");
  });
  await settle(4);
  const run = start("staging", ONE);
  await settle(4);
  act(() => {
    workbench.spaces.select("qa");
  });
  await settle(4);
  act(() => {
    workbench.operations.asking?.confirm(undefined);
  });
  await run;
  await settle(4);
  return {
    ...mount,
    uri: execUri({ ...RUNNING, space: "staging", pod: FIRST.staging ?? POD }),
  };
}

test("a shell planned while another space shows opens when its space comes back", async () => {
  const { workbench, tabs, uri } = await planAway();
  expect(panelTabs()).toEqual([]);
  act(() => {
    workbench.spaces.select("staging");
  });
  await settle(10);
  expect(panelTabs()).toEqual([uri]);
  expect(tabs.has(uri)).toBe(true);
});

test("a shell planned while another space shows ends, with its place freed, when the person goes to a third", async () => {
  const { workbench, tabs, backend, uri } = await planAway();
  const invoke = vi.spyOn(backend, "invoke");
  act(() => {
    workbench.spaces.select("prod-eu");
  });
  await settle(10);
  act(() => {
    workbench.spaces.select("staging");
  });
  await settle(10);
  expect(panelTabs()).toEqual([]);
  expect(tabs.has(uri)).toBe(false);
  expect(invoke.mock.calls.filter(([c]) => c === "shell_close")).toHaveLength(
    1,
  );
  expect(screen.queryByText(/\d+ shells?$/)).toBeNull();
});

test("a restart that answers after the person left keeps the live terminal for the layout's tab, whichever space comes next", async () => {
  const { workbench, tabs, backend } = await mounted("shellOneContainer");
  await act(() => workbench.spaces.open("staging"));
  await act(() => workbench.spaces.open("prod-eu"));
  act(() => {
    workbench.spaces.select("staging");
  });
  await settle(4);
  const uri = execUri({
    ...RUNNING,
    space: "staging",
    pod: FIRST.staging ?? POD,
  });
  act(() => {
    workbench.editors.open(uri);
  });
  await settle(10);
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await settle(6);
  act(() => {
    workbench.spaces.select("qa");
  });
  await settle(4);
  const invoke = vi.spyOn(backend, "invoke");
  act(() => {
    workbench.operations.asking?.confirm(undefined);
  });
  await settle(6);
  act(() => {
    workbench.spaces.select("prod-eu");
  });
  await settle(10);
  expect(tabs.has(uri)).toBe(true);
  expect(invoke.mock.calls.filter(([c]) => c === "shell_close")).toEqual([]);

  act(() => {
    workbench.spaces.select("staging");
  });
  await settle(10);
  expect(panelTabs()).toEqual([uri]);
  expect(screen.queryByText("This shell ended when Twigo closed")).toBeNull();
  expect(tabs.get(uri)?.live).toBe(true);
});

test("a tab the layout restored says its shell ended when Twigo closed, runs nothing, and Start plans a shell", async () => {
  const { workbench, backend } = await mounted("shellOneContainer");
  const invoke = vi.spyOn(backend, "invoke");
  const subscribe = vi.spyOn(backend, "subscribe");
  const uri = execUri(RUNNING);
  act(() => {
    workbench.editors.open(uri);
  });
  await settle(10);
  screen.getByText("This shell ended when Twigo closed");
  const shells = (calls: readonly (readonly unknown[])[]) =>
    calls
      .map(([command]) => String(command))
      .filter((command) => /^(shell_|command_)/.test(command));
  expect(shells(invoke.mock.calls)).toEqual([]);
  expect(shells(subscribe.mock.calls)).toEqual([]);
  expect(screen.getAllByText("Ended").length).toBeGreaterThan(0);

  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await settle(10);
  expect(invoke.mock.calls.map(([command]) => command)).toContain(
    "command_plan",
  );
  expect(
    invoke.mock.calls.find(([command]) => command === "command_plan")?.[1],
  ).toEqual({
    action: "shell",
    target: {
      space: "qa",
      namespace: NAMESPACE,
      pod: POD,
      container: "api",
    },
    kind: "shell",
  });
  expect(screen.queryByText("This shell ended when Twigo closed")).toBeNull();
});

test("an ending is worded in the tab's actions with Restart there", async () => {
  const inline = await mounted("shellNoShell");
  await inline.open("qa", ONE);
  await settle(10);
  screen.getByText("No shell");
  expect(screen.queryByText("Restart")).toBeNull();
  screen.getByRole("button", { name: "Restart Shell" });
});

test("Restart asks again and starts a new session in the same tab", async () => {
  const { workbench, tabs, open } = await mounted("shellNoShell");
  await open("qa", ONE);
  const uri = execUri(RUNNING);
  const tab = tabs.get(uri);
  const run = vi.spyOn(workbench.operations, "run");
  fireEvent.click(screen.getByRole("button", { name: "Restart Shell" }));
  await settle(10);
  expect(run).toHaveBeenCalledOnce();
  expect(tabs.get(uri)).toBe(tab);
  expect(panelTabs()).toEqual([uri]);
});

test("a tab closed while Restart waits for its plan stays closed, and the session the plan ends with is closed", async () => {
  const { workbench, tabs, backend, open } = await mounted("shellNoShell");
  await open("qa", ONE);
  const uri = execUri(RUNNING);
  const original = workbench.operations.run.bind(workbench.operations);
  let answer: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const sessions: number[] = [];
  vi.spyOn(workbench.operations, "run").mockImplementation(
    async (plan, options) => {
      await gate;
      const outcome = await original(plan, options);
      if (outcome.state === "session") sessions.push(outcome.id);
      return outcome;
    },
  );
  const closed: unknown[] = [];
  const invoke = backend.invoke.bind(backend);
  vi.spyOn(backend, "invoke").mockImplementation(
    (command: string, request: unknown) => {
      if (command === "shell_close") closed.push(request);
      return invoke(command as never, request as never);
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "Restart Shell" }));
  await settle(4);
  act(() => {
    workbench.editors.close(uri);
  });
  await settle(4);
  answer();
  await settle(10);

  expect(panelTabs()).toEqual([]);
  expect(tabs.has(uri)).toBe(false);
  expect(sessions).toHaveLength(1);
  expect(closed).toContain(sessions[0]);
});

test("a shell that waits says so in the tab, with the cluster's sessions", async () => {
  const { open } = await mounted("shellQueued");
  await open("qa", ONE);
  screen.getByText("Waiting for a place among the cluster's 64 sessions.");
  screen.getByText("Queued");
});

test("the status bar lists open shells while there are any, to go to one or close it", async () => {
  const { workbench, tabs, open } = await mounted("shellOneContainer");
  expect(screen.queryByText(/shells?$/)).toBeNull();
  await open("qa", ONE);
  await open("qa", ONE);
  screen.getByText("2 shells");

  const show = workbench.commands.execute(
    "k8s.shell.show",
    workbench.keys.lookup(null),
  );
  await settle(2);
  const items = workbench.quickAccess.session?.pick?.items;
  expect(items?.map((item) => item.label)).toEqual([
    `${POD} · api`,
    `${POD} · api (2)`,
  ]);
  await pick(workbench, execUri({ ...RUNNING, n: 2 }));
  await show;
  expect(workbench.editors.activeIn("panel")).toBe(
    execUri({ ...RUNNING, n: 2 }),
  );

  const close = workbench.commands.execute(
    "k8s.shell.close",
    workbench.keys.lookup(null),
  );
  await settle(2);
  await pick(workbench, execUri(RUNNING));
  await close;
  expect(panelTabs()).toEqual([execUri({ ...RUNNING, n: 2 })]);
  expect(tabs.has(execUri(RUNNING))).toBe(false);
  screen.getByText("1 shell");
});

test("a shell that ended is not counted among the open ones", async () => {
  const { open } = await mounted("shellNoShell");
  await open("qa", ONE);
  expect(screen.queryByText(/^\d+ shells?$/)).toBeNull();
});

test("a shell tab that opens takes the focus", async () => {
  const { open } = await mounted("shellOneContainer");
  await open("qa", ONE);
  expect(document.activeElement).toBe(
    document.querySelector(".xterm-helper-textarea"),
  );
});

test("a panel shown again gives the focus to the active tab's terminal", async () => {
  const { workbench, tabs, open } = await mounted("shellOneContainer");
  await open("qa", ONE);
  await open("qa", ONE);
  const textarea = tabs.get(execUri({ ...RUNNING, n: 2 }))?.term.textarea;
  expect(document.activeElement).toBe(textarea);

  act(() => {
    workbench.spaces.setPart("qa", "panel", { visible: false });
  });
  await settle(4);
  act(() => {
    (document.activeElement as HTMLElement).blur();
  });
  expect(document.activeElement).toBe(document.body);
  act(() => {
    workbench.spaces.setPart("qa", "panel", { visible: true });
  });
  await settle(4);
  expect(document.activeElement).toBe(textarea);
});

test("a panel shown while quick access is open leaves the focus in it", async () => {
  const { workbench, tabs, open } = await mounted("shellOneContainer");
  await open("qa", ONE);
  act(() => {
    workbench.spaces.setPart("qa", "panel", { visible: false });
  });
  await settle(4);
  act(() => {
    workbench.quickAccess.show("");
  });
  await settle(4);
  const field = screen.getByRole("combobox");
  expect(document.activeElement).toBe(field);
  act(() => {
    workbench.spaces.setPart("qa", "panel", { visible: true });
  });
  await settle(4);
  expect(document.activeElement).toBe(field);
  expect(document.activeElement).not.toBe(
    tabs.get(execUri(RUNNING))?.term.textarea,
  );
});

test("a panel shown with split groups gives the focus to the active group's tab only", async () => {
  const { workbench, tabs, open } = await mounted("shellOneContainer");
  await open("qa", ONE);
  await open("qa", ONE);
  const first = execUri(RUNNING);
  const second = execUri({ ...RUNNING, n: 2 });
  act(() => {
    workbench.editors.moveActive("right", "panel");
  });
  await settle(4);
  act(() => {
    workbench.editors.open(first);
  });
  await settle(4);
  expect(workbench.editors.activeIn("panel")).toBe(first);
  act(() => {
    workbench.spaces.setPart("qa", "panel", { visible: false });
  });
  await settle(4);
  act(() => {
    (document.activeElement as HTMLElement).blur();
  });
  act(() => {
    workbench.spaces.setPart("qa", "panel", { visible: true });
  });
  await settle(4);
  expect(document.activeElement).toBe(tabs.get(first)?.term.textarea);
  expect(document.activeElement).not.toBe(tabs.get(second)?.term.textarea);
});

test("a space that comes back with a maximized panel gives the focus to its shell", async () => {
  const { workbench, tabs, open } = await mounted("shellOneContainer");
  await open("qa", ONE);
  act(() => {
    workbench.spaces.setPart("qa", "panel", { maximized: true });
  });
  await settle(4);
  await act(() => workbench.spaces.open("staging"));
  await settle(4);
  act(() => {
    workbench.spaces.select("qa");
  });
  await settle(4);
  expect(document.activeElement).toBe(
    tabs.get(execUri(RUNNING))?.term.textarea,
  );
});

test("the terminal's keys never reach a list's bare ones", async () => {
  const { workbench, open } = await mounted("shellOneContainer");
  await open("qa", ONE);
  const textarea = document.querySelector<HTMLTextAreaElement>(
    ".xterm-helper-textarea",
  );
  if (!textarea) throw new Error("no terminal");
  const execute = vi.spyOn(workbench.commands, "execute");
  const press = (init: KeyboardEventInit, target: Element = textarea) => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    target.dispatchEvent(event);
    return workbench.keybindings.dispatch(event);
  };
  expect(press({ key: "s", code: "KeyS" })).toBe(false);
  expect(press({ key: "l", code: "KeyL" })).toBe(false);
  expect(execute).not.toHaveBeenCalled();
});

const keydown = (target: Element, init: KeyboardEventInit, keyCode: number) => {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  Object.defineProperty(event, "keyCode", { value: keyCode });
  target.dispatchEvent(event);
};

const terminalOf = () => {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    ".xterm-helper-textarea",
  );
  if (!textarea) throw new Error("no terminal");
  return textarea;
};

const panelShown = (workbench: Workbench) =>
  workbench.spaces.state("qa").parts.panel.visible;

test("a ⌘ binding stays the workbench's, and the second press of a chord goes to it, not to the shell", async () => {
  const { workbench, backend, open } = await mounted("shellOneContainer");
  const ran = vi.fn();
  workbench.commands.register({
    id: "test.chord",
    title: "Chord",
    category: "Test",
    run: ran,
  });
  workbench.keybindings.register("user", [
    { key: "mod+k enter", command: "test.chord" },
  ]);
  await open("qa", ONE);
  const textarea = terminalOf();
  const invoke = vi.spyOn(backend, "invoke");
  const inputs = () => invoke.mock.calls.filter(([c]) => c === "shell_input");

  keydown(textarea, { key: "k", code: "KeyK", metaKey: true }, 75);
  expect(workbench.keybindings.pending).toHaveLength(1);
  keydown(textarea, { key: "Enter", code: "Enter" }, 13);
  await settle(4);
  expect(ran).toHaveBeenCalledOnce();
  expect(workbench.keybindings.pending).toEqual([]);
  expect(inputs()).toEqual([]);

  keydown(textarea, { key: "j", code: "KeyJ", metaKey: true }, 74);
  await settle(4);
  expect(panelShown(workbench)).toBe(false);
  expect(inputs()).toEqual([]);
});

test("on Linux and Windows quick access, the command palette and the panel's toggle win over the shell, and every other Ctrl chord stays with it", async () => {
  const { workbench, backend, open } = await mounted(
    "shellOneContainer",
    undefined,
    "linux",
  );
  await open("qa", ONE);
  const textarea = terminalOf();
  const invoke = vi.spyOn(backend, "invoke");
  const inputs = () =>
    invoke.mock.calls
      .filter(([c]) => c === "shell_input")
      .map(([, request]) => (request as { data: number[] }).data);

  keydown(textarea, { key: "p", code: "KeyP", ctrlKey: true }, 80);
  await settle(4);
  expect(workbench.quickAccess.session).toBeDefined();
  act(() => {
    workbench.quickAccess.hide();
  });
  keydown(
    textarea,
    { key: "P", code: "KeyP", ctrlKey: true, shiftKey: true },
    80,
  );
  await settle(4);
  expect(workbench.quickAccess.session).toBeDefined();
  act(() => {
    workbench.quickAccess.hide();
  });
  expect(inputs()).toEqual([]);

  const sidebar = () => workbench.spaces.state("qa").parts.sidebar.visible;
  const before = sidebar();
  keydown(textarea, { key: "b", code: "KeyB", ctrlKey: true }, 66);
  await settle(4);
  expect(inputs()).toEqual([[2]]);
  expect(sidebar()).toBe(before);

  keydown(textarea, { key: "j", code: "KeyJ", ctrlKey: true }, 74);
  await settle(4);
  expect(panelShown(workbench)).toBe(false);
  expect(inputs()).toEqual([[2]]);
});

test("a click on a shell's tab gives its terminal the focus, so the keys reach its session", async () => {
  const { workbench, tabs, backend, open } = await mounted("shellOneContainer");
  await open("qa", ONE);
  await open("qa", ONE);
  const uris = [execUri(RUNNING), execUri({ ...RUNNING, n: 2 })] as const;
  const invoke = vi.spyOn(backend, "invoke");
  const inputs = () =>
    invoke.mock.calls
      .filter(([command]) => command === "shell_input")
      .map(([, request]) => request as { id: number; data: number[] });
  for (const uri of uris) {
    act(() => {
      tabs.get(uri)?.term.input("x");
    });
    await settle(2);
  }
  const [one, two] = inputs().map(({ id }) => id);
  expect(one).not.toBe(two);
  expect(workbench.editors.activeIn("panel")).toBe(uris[1]);
  invoke.mockClear();

  click(tabElement(uris[0]));
  await settle(4);
  expect(workbench.editors.activeIn("panel")).toBe(uris[0]);
  expect(document.activeElement).toBe(tabs.get(uris[0])?.term.textarea);
  ctrlC(document.activeElement ?? document.body);
  await settle(2);
  expect(inputs()).toEqual([{ id: one, data: [3] }]);
});

test("a click on the empty part of the tab strip leaves the shell that has the focus with it", async () => {
  const { tabs, backend, open } = await mounted("shellOneContainer");
  await open("qa", ONE);
  await open("qa", ONE);
  const textarea = tabs.get(execUri({ ...RUNNING, n: 2 }))?.term.textarea;
  expect(document.activeElement).toBe(textarea);
  const invoke = vi.spyOn(backend, "invoke");

  click(stripOf("panel"));
  await settle(4);
  expect(document.activeElement).toBe(textarea);
  ctrlC(document.activeElement ?? document.body);
  await settle(2);
  expect(
    invoke.mock.calls
      .filter(([command]) => command === "shell_input")
      .map(([, request]) => (request as { data: number[] }).data),
  ).toEqual([[3]]);
});

test("a tab that moves to another view keeps its terminal and its session", async () => {
  const { workbench, tabs, backend, open } = await mounted("shellOneContainer");
  await open("qa", ONE);
  await open("qa", ONE);
  const uri = execUri({ ...RUNNING, n: 2 });
  const tab = tabs.get(uri);
  const host = tab?.host;
  const groups = () =>
    document.querySelectorAll('[aria-label="Panel"] .dv-groupview');
  expect(groups()).toHaveLength(1);
  const subscribe = vi.spyOn(backend, "subscribe");
  const invoke = vi.spyOn(backend, "invoke");
  act(() => {
    workbench.editors.moveActive("right", "panel");
  });
  await settle(10);
  expect(groups()).toHaveLength(2);
  expect(groups()[1]?.contains(host ?? null)).toBe(true);
  act(() => {
    workbench.spaces.setPart("qa", "panel", { visible: false });
  });
  await settle(4);
  act(() => {
    workbench.spaces.setPart("qa", "panel", { visible: true });
  });
  await settle(10);
  expect(tabs.get(uri)).toBe(tab);
  expect(tab?.host).toBe(host);
  expect(host?.isConnected).toBe(true);
  expect(subscribe).not.toHaveBeenCalled();
  expect(invoke.mock.calls.filter(([c]) => c === "shell_close")).toEqual([]);
});

test("a hidden panel or a tab behind another holds no WebGL, and showing it loads one", async () => {
  const made: { disposed: boolean }[] = [];
  const webgl = (): WebglRenderer => {
    const entry = { disposed: false };
    made.push(entry);
    return {
      activate: () => undefined,
      dispose: () => {
        entry.disposed = true;
      },
      onContextLoss: () => ({ dispose: () => undefined }),
    };
  };
  const { workbench, tabs, open } = await mounted("shellOneContainer", webgl);
  await open("qa", ONE);
  const first = tabs.get(execUri(RUNNING));
  expect(first?.renderer).toBe("webgl");

  act(() => {
    workbench.spaces.setPart("qa", "panel", { visible: false });
  });
  await settle(4);
  expect(first?.renderer).toBe("dom");
  act(() => {
    workbench.spaces.setPart("qa", "panel", { visible: true });
  });
  await settle(4);
  expect(first?.renderer).toBe("webgl");

  await open("qa", ONE);
  const second = tabs.get(execUri({ ...RUNNING, n: 2 }));
  expect(second?.renderer).toBe("webgl");
  expect(first?.renderer).toBe("dom");
  expect(made.filter(({ disposed }) => !disposed)).toHaveLength(1);
});

async function kubeMounted() {
  const workbench = await testWorkbench("shellOneContainer");
  registerKube(workbench);
  await act(() => workbench.spaces.open("qa"));
  act(() => {
    workbench.spaces.select("qa");
  });
  render(<WorkbenchView workbench={workbench} />);
  await settle();
  return workbench;
}

test("a pod's editor offers Shell in its title, and a deployment's does not", async () => {
  const workbench = await kubeMounted();
  const execute = vi.spyOn(workbench.commands, "execute");
  act(() => {
    workbench.editors.open(
      objectUri({ space: "qa", gvr: PODS, namespace: NAMESPACE, name: POD }),
    );
  });
  await settle(10);
  fireEvent.click(screen.getByRole("button", { name: "Shell" }));
  await settle(10);
  expect(execute).toHaveBeenCalledWith(
    "k8s.shell.open",
    expect.anything(),
    expect.objectContaining({
      space: "qa",
      gvr: PODS,
      namespace: NAMESPACE,
      name: POD,
    }),
  );
  cleanup();

  const other = await kubeMounted();
  act(() => {
    other.editors.open(
      objectUri({
        space: "qa",
        gvr: { group: "apps", version: "v1", resource: "deployments" },
        namespace: NAMESPACE,
        name: "auth-api",
      }),
    );
  });
  await settle(10);
  expect(screen.queryByRole("button", { name: "Shell" })).toBeNull();
});
