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
import { WorkbenchView, type Workbench } from "@twigo/workbench";
import { tabsIn, testWorkbench } from "@twigo/workbench/testing";
import { settle, withScreenSize } from "../../test/workbench";
import { withTerminalLayout } from "../../test/terminal";
import { execUri, objectUri, type ExecInput } from "../uri";
import { registerKube } from "../register";
import { createExecTabs, registerExec } from "./register";
import { ExecTabs, type WebglRenderer } from "./tabs";
import type { ExecVariants } from "./variants";

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
  variants: ExecVariants = { end: "inline", again: "new" },
  webgl?: () => WebglRenderer,
): Promise<Mounted> {
  const backend = createMockBackend(scenario);
  const workbench = await testWorkbench(scenario, backend);
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
  registerExec(workbench, tabs, variants);
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

test("a second shell on a container opens another tab by default, and focuses the first where the variant says", async () => {
  const fresh = await mounted("shellOneContainer");
  await fresh.open("qa", ONE);
  await fresh.open("qa", ONE);
  expect(panelTabs()).toEqual([
    execUri(RUNNING),
    execUri({ ...RUNNING, n: 2 }),
  ]);
  cleanup();

  const focus = await mounted("shellOneContainer", {
    end: "inline",
    again: "focus",
  });
  const run = vi.spyOn(focus.workbench.operations, "run");
  await focus.open("qa", ONE);
  await focus.open("qa", ONE);
  expect(run).toHaveBeenCalledOnce();
  expect(panelTabs()).toEqual([execUri(RUNNING)]);
});

test("where a live shell is focused, one that ended is started again in its own tab, and New Shell opens another", async () => {
  const { workbench, tabs, open } = await mounted("shellNoShell", {
    end: "inline",
    again: "focus",
  });
  await open("qa", ONE);
  const uri = execUri(RUNNING);
  expect(tabs.get(uri)?.getStatus().state).toBe("ended");
  const first = tabs.get(uri);
  await open("qa", ONE);
  expect(panelTabs()).toEqual([uri]);
  expect(tabs.get(uri)).toBe(first);

  await act(() =>
    workbench.commands.execute(
      "k8s.shell.new",
      (key) => key === "execTab" || workbench.keys.lookup(null)(key),
      { uri },
    ),
  );
  await settle(10);
  expect(panelTabs()).toEqual([uri, execUri({ ...RUNNING, n: 2 })]);
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

test("an ending is worded in the tab's actions with Restart there, or in a bar across the terminal", async () => {
  const inline = await mounted("shellNoShell");
  await inline.open("qa", ONE);
  await settle(10);
  screen.getByText("No shell");
  expect(screen.queryByText("Restart")).toBeNull();
  screen.getByRole("button", { name: "Restart Shell" });
  cleanup();

  const bar = await mounted("shellNoShell", { end: "bar", again: "new" });
  await bar.open("qa", ONE);
  await settle(10);
  expect(
    screen.getByRole("button", { name: "Restart" }).parentElement?.textContent,
  ).toContain("This container has no shell.");
  expect(screen.queryByRole("button", { name: "Restart Shell" })).toBeNull();
});

test("Restart asks again and starts a new session in the same tab", async () => {
  const { workbench, tabs, open } = await mounted("shellNoShell", {
    end: "bar",
    again: "new",
  });
  await open("qa", ONE);
  const uri = execUri(RUNNING);
  const tab = tabs.get(uri);
  const run = vi.spyOn(workbench.operations, "run");
  fireEvent.click(screen.getByRole("button", { name: "Restart" }));
  await settle(10);
  expect(run).toHaveBeenCalledOnce();
  expect(tabs.get(uri)).toBe(tab);
  expect(panelTabs()).toEqual([uri]);
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

test("the terminal's keys never reach a list's bare ones, and a chord that is bound stays the workbench's", async () => {
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

  expect(
    workbench.keybindings.handles(
      new KeyboardEvent("keydown", { code: "KeyJ", metaKey: true }),
    ),
  ).toBe(true);
});

test("a tab that moves to another view keeps its terminal and its session", async () => {
  const { workbench, tabs, backend, open } = await mounted("shellOneContainer");
  await open("qa", ONE);
  const uri = execUri(RUNNING);
  const tab = tabs.get(uri);
  const host = tab?.host;
  const subscribe = vi.spyOn(backend, "subscribe");
  const invoke = vi.spyOn(backend, "invoke");
  act(() => {
    workbench.editors.close("k8s-list://qa/v1/pods");
    workbench.editors.moveActive("right", "panel");
  });
  await settle(10);
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
  const { workbench, tabs, open } = await mounted(
    "shellOneContainer",
    { end: "inline", again: "new" },
    webgl,
  );
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
