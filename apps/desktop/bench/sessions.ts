import type { Forward } from "@twigo/protocol";
import { SET_CONTEXT_ENVIRONMENT, type Workbench } from "@twigo/workbench";
import { sleep } from "./driver";
import type { Probe, ShellProbe } from "./probe";

/** What `bench/harness.sh` gives the app in `TWIGO_BENCH_SESSIONS`. */
export interface Target {
  shell: { namespace: string; pod: string; container: string };
  forward: { namespace: string; pod: string; port: number };
  /** The `kubectl` of the harness's `PATH`, which the terminal runs. */
  kubectl: string;
  /** The cluster's own kubeconfig, which a watch straight to the cluster names. */
  kubeconfig: string;
}

/** How the terminal's `kubectl get pods -A -w` reaches the cluster. */
export type Via = "proxy" | "direct";

/**
 * The windows the harness samples the core's CPU in, in this order, so that a
 * drift of the cluster or the page over them cancels between the two.
 */
export const WATCHES: readonly Via[] = ["proxy", "direct", "direct", "proxy"];

/** What `sessions.json` says of the three sessions once they are open. */
export interface Opened {
  shell: { pod: string; question: string };
  forward: { target: string; port: number; local: number };
  terminal: { kind: string; shell: string };
}

/** Longer than the harness's settling and its five memory samples, as `bench/harness.sh` checks. */
export const MEMORY_MS = 30_000;
/** Longer than the harness's settling and sampling of one window. */
export const WINDOW_MS = 35_000;

const PODS = { group: "", version: "v1", resource: "pods" };
const POLL_MS = 50;
const ASK_MS = 10_000;
const OPEN_MS = 30_000;
/** The least a pod's row takes in the first list of `kubectl get pods -A -w`. */
const ROW_BYTES = 60;
const FIRST_ROWS_MS = 90_000;
const QUIET_MS = 1000;
/** The type the bench's context is marked as: it asks before a shell and its terminal goes through the policy proxy. */
const MARK = "staging";

const encoder = new TextEncoder();

/** Resolves with what `ready` returns once it is not undefined, naming `what` if it is not within `ms`. */
async function poll<T>(
  ready: () => T | undefined,
  what: string,
  ms = OPEN_MS,
): Promise<T> {
  const deadline = performance.now() + ms;
  for (;;) {
    const found = ready();
    if (found !== undefined) return found;
    if (performance.now() > deadline) {
      throw new Error(`no ${what} within ${String(ms)} ms`);
    }
    await sleep(POLL_MS);
  }
}

function quote(word: string): string {
  return `'${word.replace(/'/g, "'\\''")}'`;
}

function type(probe: Probe, shell: ShellProbe, text: string): Promise<null> {
  return probe.backend.invoke("shell_input", {
    id: shell.id,
    data: [...encoder.encode(text)],
  });
}

function state(what: string, shell: ShellProbe): string {
  const now = shell.state;
  return `${what} is ${now.state === "ended" ? `ended: ${JSON.stringify(now.end)}` : now.state}`;
}

function running(what: string, shell: ShellProbe): void {
  if (shell.state.state !== "running") throw new Error(state(what, shell));
}

/** Resolves once the session runs, and fails at once when it has ended. */
function started(what: string, shell: ShellProbe): Promise<void> {
  return poll(() => {
    if (shell.state.state === "ended") throw new Error(state(what, shell));
    return shell.state.state === "running" ? true : undefined;
  }, `running ${what}`).then(() => undefined);
}

/**
 * Answers the dialog `run` asks in, as a person does with its button, and
 * with the name where it asks for it typed; resolves with its question.
 */
async function answered(
  workbench: Pick<Workbench, "operations">,
  run: Promise<unknown>,
  what: string,
): Promise<string> {
  let over = false;
  void run.finally(() => {
    over = true;
  });
  const asking = await poll(
    () => {
      if (over) throw new Error(`${what} ran without asking in a dialog`);
      return workbench.operations.asking;
    },
    `dialog of ${what}`,
    ASK_MS,
  );
  const { plan, confirm } = asking;
  confirm(plan.friction.kind === "typed" ? plan.friction.text : undefined);
  return plan.question;
}

async function mark(
  workbench: Pick<Workbench, "catalog" | "commands" | "keys">,
  context: string,
): Promise<void> {
  const ran = await workbench.commands.execute(
    SET_CONTEXT_ENVIRONMENT,
    workbench.keys.lookup(null),
    { context, value: MARK },
  );
  if (!ran) throw new Error("the command that sets a context's type is off");
  await poll(
    () =>
      workbench.catalog.find(context)?.access.environment === MARK
        ? true
        : undefined,
    `${context} marked ${MARK}`,
  );
}

async function execute(
  workbench: Pick<Workbench, "commands" | "keys">,
  command: string,
  args?: unknown,
): Promise<void> {
  const ran = await workbench.commands.execute(
    command,
    workbench.keys.lookup(null),
    args,
  );
  if (!ran) throw new Error(`${command} is off`);
}

async function shellIn(
  workbench: Pick<Workbench, "commands" | "keys" | "operations">,
  probe: Probe,
  { space, shell }: { space: string; shell: Target["shell"] },
): Promise<{ session: ShellProbe; question: string }> {
  const before = probe.shells.length;
  const opening = execute(workbench, "k8s.shell.open", {
    space,
    gvr: PODS,
    namespace: shell.namespace,
    name: shell.pod,
    container: shell.container,
  });
  const question = await answered(workbench, opening, "the shell");
  await opening;
  const session = await poll(
    () => probe.shells[before],
    "channel of the shell",
  );
  await started("the shell", session);
  return { session, question };
}

async function forwardOf(
  workbench: Pick<Workbench, "commands" | "keys" | "quickAccess">,
  probe: Probe,
  { space, forward }: { space: string; forward: Target["forward"] },
): Promise<Forward> {
  const opening = execute(workbench, "k8s.forward.open", {
    space,
    gvr: PODS,
    namespace: forward.namespace,
    name: forward.pod,
  });
  const { items } = await poll(
    () => workbench.quickAccess.session?.pick,
    "pick of the port to forward",
    ASK_MS,
  );
  const item = items.find((each) => each.id === String(forward.port));
  if (!item) {
    const offered = items.map((each) => each.id).join(", ");
    throw new Error(
      `${forward.pod} offers ports ${offered}, not ${String(forward.port)}`,
    );
  }
  await workbench.quickAccess.accept(item);
  await opening;
  const { forwardStarted: started } = probe;
  if (started?.outcome !== "started") {
    throw new Error(
      `the forward did not start: ${JSON.stringify(started ?? "no answer")}; local port ${String(forward.port)} must be free on this Mac`,
    );
  }
  const id = started.forward.id;
  const settled = await poll(() => {
    const told = probe.forwards.get(id);
    return told?.state.state === "starting" ? undefined : told;
  }, "forward past starting");
  if (settled.state.state !== "ready") {
    throw new Error(`the forward is ${JSON.stringify(settled.state)}`);
  }
  return settled;
}

/**
 * Runs `kubectl get pods -A -w` in the terminal once the one before it has
 * ended, through the proxy that the terminal's kubeconfig names or straight
 * to the cluster, and resolves once the first list of every pod has come.
 */
export async function watching(
  probe: Probe,
  terminal: ShellProbe,
  {
    target,
    rows,
    via,
    was,
  }: {
    target: Target;
    rows: number;
    via: Via;
    was: Via | undefined;
  },
): Promise<void> {
  if (was === via) return;
  if (was !== undefined) {
    await type(probe, terminal, "\x03");
    await poll(
      () =>
        performance.now() - terminal.lastAt >= QUIET_MS ? true : undefined,
      "terminal that is quiet after Ctrl-C",
      ASK_MS,
    );
  }
  const kubectl = quote(target.kubectl);
  const command =
    via === "proxy"
      ? `${kubectl} get pods -A -w`
      : `${kubectl} --kubeconfig ${quote(target.kubeconfig)} get pods -A -w`;
  const before = terminal.bytes;
  await type(probe, terminal, `${command}\r`);
  await poll(
    () => (terminal.bytes - before >= rows * ROW_BYTES ? true : undefined),
    `first rows of the watch ${via === "proxy" ? "through the proxy" : "straight to the cluster"}`,
    FIRST_ROWS_MS,
  ).catch((error: unknown) => {
    const last = JSON.stringify(terminal.tail.slice(-500));
    throw new Error(`${String(error)}; the terminal's last output: ${last}`);
  });
}

/**
 * Opens, in the bench's one space and as a person opens them, a shell in a
 * pod of kind's node, a port-forward and a terminal, through the context's
 * friction: the type is set by the command of the chip's choices, and the
 * shell's dialog is answered through its own button. Then the terminal runs
 * a watch of the pods through the policy proxy, and the list is back on
 * screen in the editor area.
 */
async function openSessions(
  workbench: Pick<
    Workbench,
    "catalog" | "commands" | "editors" | "keys" | "operations" | "quickAccess"
  >,
  probe: Probe,
  {
    space,
    context,
    list,
    rows,
    target,
  }: {
    space: string;
    context: string;
    /** The URI of the pod list. */
    list: string;
    rows: number;
    target: Target;
  },
): Promise<{ opened: Opened; terminal: ShellProbe }> {
  await mark(workbench, context);
  const { session: shell, question } = await shellIn(workbench, probe, {
    space,
    shell: target.shell,
  });
  const forward = await forwardOf(workbench, probe, {
    space,
    forward: target.forward,
  });
  await execute(workbench, "k8s.terminal.new");
  const created = probe.terminal;
  if (created?.kind.kind !== "proxy") {
    throw new Error(
      `the terminal does not go through the policy proxy: ${JSON.stringify(created?.kind)}`,
    );
  }
  const terminal = await poll(
    () => probe.shells.find((each) => each.id === created.id),
    "channel of the terminal",
  );
  await started("the terminal", terminal);
  workbench.editors.open(list);
  await watching(probe, terminal, {
    target,
    rows,
    via: "proxy",
    was: undefined,
  });
  running("the shell", shell);
  running("the terminal", terminal);
  return {
    opened: {
      shell: { pod: target.shell.pod, question },
      forward: {
        target: forward.target.name,
        port: forward.port,
        local: forward.local,
      },
      terminal: { kind: created.kind.kind, shell: created.shell },
    },
    terminal,
  };
}

/**
 * The windows the harness samples: for each of `WATCHES`, the terminal's
 * watch is the one it names, `watch-N` says so and how many bytes the
 * terminal has had, and `watched-N` says how many it had when the window
 * ended.
 */
async function windows(
  probe: Probe,
  terminal: ShellProbe,
  {
    rows,
    target,
    write,
  }: {
    rows: number;
    target: Target;
    write: (name: string, value: unknown) => Promise<void>;
  },
): Promise<void> {
  let was: Via | undefined = "proxy";
  for (const [index, via] of WATCHES.entries()) {
    await watching(probe, terminal, { target, rows, via, was });
    was = via;
    const n = String(index + 1);
    await write(`watch-${n}`, { via, bytes: terminal.bytes, atMs: Date.now() });
    await sleep(WINDOW_MS);
    running("the terminal", terminal);
    await write(`watched-${n}`, {
      via,
      bytes: terminal.bytes,
      atMs: Date.now(),
    });
  }
}

/**
 * The phases after the pod list's: the three sessions open, `sessions.json`
 * says so for the harness, which reads the forward once and samples memory,
 * then the terminal's watch runs in each of `WATCHES`' windows.
 */
export async function driveSessions(
  workbench: Parameters<typeof openSessions>[0],
  probe: Probe,
  {
    write,
    ...opening
  }: Parameters<typeof openSessions>[2] & {
    write: (name: string, value: unknown) => Promise<void>;
  },
): Promise<void> {
  const { opened, terminal } = await openSessions(workbench, probe, opening);
  await write("sessions", opened);
  await sleep(MEMORY_MS);
  await windows(probe, terminal, { ...opening, write });
}
