import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { LogBatch, LogPod, StreamState, ViewState } from "@twigo/protocol";
import { createMockBackend, type MockScenario } from "@twigo/protocol/mock";
import { WorkbenchView } from "@twigo/workbench";
import { tabsIn, testWorkbench } from "@twigo/workbench/testing";
import { bareTabPaths, settle, withScreenSize } from "../test/workbench";
import { withTerminalLayout } from "../test/terminal";
import { createExecTabs, registerExec } from "./exec/register";
import { registerLogs } from "./logs/register";
import { LogsTabs } from "./logs/state";
import { createTerminalTabs, registerTerminals } from "./terminal/register";
import { registerSessions } from "./sessions";
import { execUri, logsUri, terminalUri } from "./uri";

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

const SPACE = "qa";
const PODS = { group: "", version: "v1", resource: "pods" };
const TARGET = {
  space: SPACE,
  gvr: PODS,
  namespace: "auth",
  name: "auth-api-1p2si70-e9vxn",
};

async function mounted(scenario: MockScenario = "shellOneContainer") {
  const backend = createMockBackend(scenario);
  const workbench = await testWorkbench(scenario, backend);
  const logs = new LogsTabs(backend);
  const shells = createExecTabs(workbench);
  const terminals = createTerminalTabs(workbench);
  const paths = bareTabPaths(workbench);
  registerLogs(workbench, logs, paths);
  registerExec(workbench, shells, paths);
  registerTerminals(workbench, terminals, paths);
  registerSessions(workbench, { logs, shells, terminals });
  await act(() => workbench.spaces.open(SPACE));
  act(() => {
    workbench.spaces.select(SPACE);
  });
  render(<WorkbenchView workbench={workbench} />);
  await settle();
  const lookup = () => workbench.keys.lookup(null);
  const run = async (command: string, args?: unknown) => {
    const done = workbench.commands.execute(command, lookup(), args);
    await settle(10);
    await done;
  };
  const panel = () => workbench.spaces.state(SPACE).parts.panel;
  const closed = () => {
    const invoke = vi.spyOn(backend, "invoke");
    return () =>
      invoke.mock.calls
        .map(([command]) => command)
        .filter(
          (command) => command === "shell_close" || command === "logs_close",
        );
  };
  return { workbench, logs, shells, terminals, run, panel, closed, backend };
}

const inPanel = () => {
  const panel = document.querySelector<HTMLElement>('[aria-label="Panel"]');
  if (!panel) throw new Error("no panel");
  return within(panel);
};
const only = <T,>(list: readonly (readonly [string, T])[]) => {
  const [first] = list;
  if (!first) throw new Error("no tab");
  return first;
};
const statusBar = () => screen.getByRole("contentinfo");

test("hiding the panel ends no session, and its tabs and sessions are there when it shows again", async () => {
  const { workbench, shells, terminals, logs, run, panel, closed } =
    await mounted();
  const ended = closed();
  await run("k8s.terminal.new");
  await run("k8s.shell.open", { ...TARGET, container: "api" });
  await run("k8s.logs.open", TARGET);
  const uris = [
    terminalUri({ space: SPACE, n: 1 }),
    execUri({ ...TARGET, space: SPACE, pod: TARGET.name, container: "api" }),
    logsUri(TARGET),
  ].sort();
  expect(tabsIn("panel").sort()).toEqual(uris);
  await run("workbench.action.closePanel");
  await settle(4);
  expect(panel().visible).toBe(false);
  expect(ended()).toEqual([]);
  expect(shells.list().map(([, tab]) => tab.live)).toEqual([true]);
  expect(terminals.list().map(([, tab]) => tab.live)).toEqual([true]);
  expect(logs.live(SPACE)).toBe(1);
  expect(within(statusBar()).getByText("3 sessions")).toBeTruthy();

  fireEvent.click(within(statusBar()).getByText("3 sessions"));
  await settle(4);
  expect(panel().visible).toBe(true);
  expect(tabsIn("panel").sort()).toEqual(uris);
  expect(within(statusBar()).queryByText("3 sessions")).toBeNull();
  expect(workbench.editors.activeIn("panel")).toBeDefined();
});

test.each([
  ["a terminal", "k8s.terminal.new", undefined, "Close Terminal 1"],
  [
    "a shell",
    "k8s.shell.open",
    { ...TARGET, container: "api" },
    `Close ${TARGET.name} · api`,
  ],
] as const)(
  "closing %s as the panel's last tab ends its session as it did and hides the panel",
  async (_kind, command, args, label) => {
    const { run, panel, closed } = await mounted();
    const ended = closed();
    await run(command, args);
    expect(tabsIn("panel")).toHaveLength(1);
    expect(ended()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: label }));
    await settle(4);
    expect(tabsIn("panel")).toEqual([]);
    expect(ended()).toEqual(["shell_close"]);
    expect(panel().visible).toBe(false);
  },
);

test.each([
  ["Close Terminal…", "k8s.terminal.new", undefined, "k8s.terminal.close"],
  [
    "Close Shell…",
    "k8s.shell.open",
    { ...TARGET, container: "api" },
    "k8s.shell.close",
  ],
] as const)(
  "%s as the panel's last close gives the focus back to the element that held it before the panel took it",
  async (_title, open, args, closing) => {
    const { workbench, run, panel } = await mounted();
    const before = document.body.appendChild(document.createElement("button"));
    act(() => {
      before.focus();
    });
    await run(open, args);
    expect(tabsIn("panel")).toHaveLength(1);
    const done = workbench.commands.execute(
      closing,
      workbench.keys.lookup(document.activeElement),
    );
    await settle(4);
    fireEvent.keyDown(screen.getByRole("combobox"), {
      key: "Enter",
      code: "Enter",
    });
    await settle(6);
    await done;
    expect(tabsIn("panel")).toEqual([]);
    expect(panel().visible).toBe(false);
    expect(document.activeElement).toBe(before);
    before.remove();
  },
);

test("a session that ends by itself keeps its tab and the panel, and is not counted once the panel hides", async () => {
  const { run, panel, shells } = await mounted("shellNoShell");
  await run("k8s.shell.open", { ...TARGET, container: "api" });
  const [uri, tab] = only(shells.list());
  expect(tab.live).toBe(false);
  expect(tabsIn("panel")).toEqual([uri]);
  expect(panel().visible).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Restart Shell" }));
  await settle(10);
  expect(shells.get(uri)).toBe(tab);
  expect(tabsIn("panel")).toEqual([uri]);
  expect(panel().visible).toBe(true);
  await run("workbench.action.closePanel");
  expect(tabsIn("panel")).toEqual([uri]);
  expect(within(statusBar()).queryByText(/sessions?$/)).toBeNull();
});

const STREAMS: readonly [ViewState, boolean][] = [
  [{ state: "queued" }, true],
  [{ state: "connecting" }, true],
  [{ state: "syncing", loaded: 3 }, true],
  [{ state: "ready" }, true],
  [{ state: "relisting" }, true],
  [{ state: "stale" }, true],
  [{ state: "forbidden", verb: "get", resource: "pods/log" }, false],
  [{ state: "unauthorized" }, false],
  [
    { state: "error", error: { kind: "unavailable", message: "broken" } },
    false,
  ],
];

async function hiddenWithLogs() {
  const mount = await mounted();
  const subscribe = vi.spyOn(mount.backend, "subscribe");
  await mount.run("k8s.logs.open", TARGET);
  const opened = subscribe.mock.calls.find(
    ([command]) => command === "logs_open",
  );
  if (!opened) throw new Error("no logs session opened");
  const send = opened[2] as (batch: LogBatch) => void;
  const emits = vi.spyOn(mount.logs.changes, "emit");
  let seq = 1000;
  const batch = (change: Partial<LogBatch>) => {
    emits.mockClear();
    act(() => {
      send({
        seq: seq++,
        status: { state: "ready" },
        pods: null,
        total: 0,
        window: null,
        matches: null,
        histogram: null,
        dropped: 0,
        arrived: 0,
        changes: 0,
        ...change,
      });
    });
    return emits.mock.calls.length;
  };
  await mount.run("workbench.action.closePanel");
  return { ...mount, batch };
}

const counted = () => within(statusBar()).queryByText("1 session") !== null;

test.each(STREAMS)(
  "a logs session whose target is %j is counted: %s, and the count follows it",
  async (status, shown) => {
    const { batch } = await hiddenWithLogs();
    expect(batch({ status: { state: "ready" } })).toBe(0);
    expect(counted()).toBe(true);

    expect(batch({ status })).toBe(shown ? 0 : 1);
    expect(counted()).toBe(shown);
    expect(batch({ status: { state: "ready" } })).toBe(shown ? 0 : 1);
    expect(counted()).toBe(true);
  },
);

const POD_STREAMS: readonly [StreamState, boolean][] = [
  [{ state: "following" }, true],
  [{ state: "connecting" }, true],
  [{ state: "queued" }, true],
  [{ state: "waiting", reason: "CrashLoopBackOff" }, true],
  [{ state: "ended" }, false],
  [{ state: "off" }, false],
  [{ state: "overLimit" }, false],
  [
    { state: "error", error: { kind: "unavailable", message: "broken" } },
    false,
  ],
];

const podsWith = (...streams: StreamState[]): LogPod[] => [
  {
    name: TARGET.name,
    generated: null,
    status: "Running",
    tone: "neutral",
    containers: streams.map((stream, at) => ({
      name: `container-${String(at)}`,
      stream,
    })),
  },
];

test.each(POD_STREAMS)(
  "a logs session whose only stream is %j is counted: %s, and the count follows it",
  async (stream, shown) => {
    const { batch } = await hiddenWithLogs();
    expect(batch({ pods: podsWith({ state: "following" }) })).toBe(0);
    expect(counted()).toBe(true);

    expect(batch({ pods: podsWith(stream) })).toBe(shown ? 0 : 1);
    expect(counted()).toBe(shown);
    expect(batch({ pods: podsWith({ state: "following" }) })).toBe(
      shown ? 0 : 1,
    );
    expect(counted()).toBe(true);
  },
);

test("a logs session is counted while one of its streams reads, though the others ended", async () => {
  const { batch } = await hiddenWithLogs();
  expect(
    batch({ pods: podsWith({ state: "ended" }, { state: "following" }) }),
  ).toBe(0);
  expect(counted()).toBe(true);
  expect(
    batch({ pods: podsWith({ state: "ended" }, { state: "ended" }) }),
  ).toBe(1);
  expect(counted()).toBe(false);
});

test("a logs session whose pods are known and none, as of a workload at zero replicas, waits for them and is counted", async () => {
  const { batch } = await hiddenWithLogs();
  expect(batch({ pods: podsWith({ state: "ended" }) })).toBe(1);
  expect(counted()).toBe(false);
  expect(batch({ pods: [] })).toBe(1);
  expect(counted()).toBe(true);
});

test("a tab of a previous instance, whose streams all ended, is not counted", async () => {
  const { logs, run } = await mounted();
  await run("k8s.logs.open", { ...TARGET, container: "api", previous: true });
  await settle(10);
  await run("workbench.action.closePanel");
  const [uri] = tabsIn("panel");
  if (!uri) throw new Error("no logs tab");
  expect(
    logs
      .session(uri, TARGET)
      .getSnapshot()
      .pods?.flatMap((pod) => pod.containers.map(({ stream }) => stream.state)),
  ).toContain("ended");
  expect(logs.live(SPACE)).toBe(0);
  expect(within(statusBar()).queryByText(/sessions?$/)).toBeNull();
});

test("while the panel is hidden the status bar counts the sessions in one entry, and shows the shells' own once the panel shows", async () => {
  const { run } = await mounted();
  await run("k8s.shell.open", { ...TARGET, container: "api" });
  expect(within(statusBar()).queryByText("1 shell")).not.toBeNull();
  expect(within(statusBar()).queryByText("1 session")).toBeNull();
  await run("workbench.action.closePanel");
  expect(within(statusBar()).queryByText("1 shell")).toBeNull();
  expect(within(statusBar()).queryByText("1 session")).not.toBeNull();
  await run("workbench.action.togglePanel");
  expect(within(statusBar()).queryByText("1 shell")).not.toBeNull();
  expect(within(statusBar()).queryByText("1 session")).toBeNull();
});

const close = (name: string) => {
  fireEvent.click(screen.getByRole("button", { name }));
};

test("the empty panel names the space and offers a terminal, and Reopen Logs only once the space closed logs", async () => {
  const { run, panel } = await mounted();
  await run("workbench.action.togglePanel");
  expect(panel().visible).toBe(true);
  inPanel().getByText(`No sessions in ${SPACE}`);
  const offered = () =>
    within(inPanel().getByRole("toolbar"))
      .getAllByRole("button")
      .map((button) => button.textContent.replace(/[⌃⇧`]+$/, ""));
  expect(offered()).toEqual(["New Terminal"]);
  inPanel().getByRole("button", { name: "Hide Panel" });

  await run("k8s.logs.open", TARGET);
  close(`Close Logs · pod ${TARGET.name}`);
  await settle(4);
  expect(panel().visible).toBe(false);
  await run("workbench.action.togglePanel");
  expect(offered()).toEqual(["New Terminal", "Reopen Logs"]);
  fireEvent.click(inPanel().getByRole("button", { name: /Reopen Logs/ }));
  await settle(4);
  expect(tabsIn("panel")).toEqual([logsUri(TARGET)]);
  close(`Close Logs · pod ${TARGET.name}`);
  await settle(4);
  await run("workbench.action.togglePanel");
  expect(offered()).toEqual(["New Terminal", "Reopen Logs"]);
});

test("Reopen Closed Editor brings logs back with their container and range, and starts a new shell and terminal in place of the ones that ended", async () => {
  const { workbench, logs, shells, terminals, run, backend } = await mounted();
  const uri = logsUri(TARGET);
  await run("k8s.logs.open", TARGET);
  const range = { from: "2026-11-03T10:05:00Z", to: "2026-11-03T10:10:00Z" };
  act(() => {
    logs.setSource(uri, { containers: { type: "named", name: "api" } });
    logs.setView(uri, { range });
  });
  close(`Close Logs · pod ${TARGET.name}`);
  await settle(4);
  expect(tabsIn("panel")).toEqual([]);
  expect(logs.get(uri).view.range).toBeNull();

  await run("workbench.action.reopenClosedEditor");
  expect(tabsIn("panel")).toEqual([uri]);
  expect(logs.get(uri).source.containers).toEqual({
    type: "named",
    name: "api",
  });
  expect(logs.get(uri).view.range).toEqual(range);

  await run("k8s.shell.open", { ...TARGET, container: "api" });
  const [shell] = only(shells.list());
  await run("k8s.terminal.new");
  const [terminal] = only(terminals.list());
  const invoke = vi.spyOn(backend, "invoke");
  const planned = vi.spyOn(workbench.operations, "run");
  close(`Close ${TARGET.name} · api`);
  close("Close Terminal 1");
  await settle(4);
  expect(tabsIn("panel")).toEqual([uri]);

  await run("workbench.action.reopenClosedEditor");
  expect(
    invoke.mock.calls.filter(([command]) => command === "terminal_create"),
  ).toHaveLength(1);
  expect(tabsIn("panel").sort()).toEqual([terminal, uri].sort());
  expect(shells.has(shell)).toBe(false);

  await run("workbench.action.reopenClosedEditor");
  expect(planned).toHaveBeenCalledOnce();
  expect(planned.mock.calls[0]?.[0]).toMatchObject({
    action: "shell",
    target: { pod: TARGET.name, container: "api" },
  });
  expect(tabsIn("panel").sort()).toEqual([shell, terminal, uri].sort());
});
