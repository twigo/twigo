import { afterEach, expect, test, vi } from "vitest";
import type {
  Backend,
  Forward,
  ForwardEvent,
  ForwardStarted,
  ShellMessage,
  TerminalSession,
} from "@twigo/protocol";
import { Probe } from "./probe";
import { driveSessions, type Target } from "./sessions";

vi.mock("./driver", () => ({
  sleep: (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, Math.min(ms, 1))),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const TARGET: Target = {
  shell: { namespace: "bench-sessions", pod: "shell", container: "shell" },
  forward: { namespace: "kube-system", pod: "coredns-1", port: 8080 },
  kubectl: "/usr/local/bin/kubectl",
  kubeconfig: "/tmp/it's/kubeconfig",
};
const ROWS = 100;
const TERMINAL = 7;
const SHELL = 5;
const encoder = new TextEncoder();

const forward: Forward = {
  id: 1,
  target: {
    space: "s",
    gvr: { group: "", version: "v1", resource: "pods" },
    namespace: "kube-system",
    name: "coredns-1",
  },
  kind: "Pod",
  port: 8080,
  portName: "liveness-probe",
  appProtocol: null,
  local: 8080,
  addresses: ["127.0.0.1"],
  state: { state: "ready" },
  pod: "coredns-1",
  podPort: 8080,
  connections: 0,
  queued: 0,
  sent: 0,
  received: 0,
  failure: null,
};

interface Options {
  terminal?: TerminalSession["kind"];
  forward?: ForwardStarted;
  asks?: boolean;
  friction?: { kind: "confirm" } | { kind: "typed"; text: string };
  failing?: string;
  target?: Target;
}

function fake({
  terminal = { kind: "proxy", why: "mode" },
  forward: started = { outcome: "started", forward },
  asks = true,
  friction = { kind: "confirm" },
  failing,
  target = TARGET,
}: Options = {}) {
  const log: string[] = [];
  const typed: string[] = [];
  const senders = new Map<number, (message: ShellMessage) => void>();
  let tell: ((event: ForwardEvent) => void) | undefined;
  let environment: string | null = null;
  let confirmed: string | undefined | null = null;
  let asking:
    | {
        plan: { friction: NonNullable<Options["friction"]>; question: string };
        confirm: (typed: string | undefined) => void;
      }
    | undefined;
  let pick: { items: { id: string }[] } | undefined;
  const inner: Backend = {
    invoke: (command: string, request: unknown) => {
      switch (command) {
        case "terminal_create":
          return Promise.resolve({
            id: TERMINAL,
            kind: terminal,
            shell: "zsh",
            kubeconfigKept: true,
          } satisfies TerminalSession);
        case "forward_start":
          if (started.outcome === "started") {
            tell?.({ event: "changed", forward: started.forward });
          }
          return Promise.resolve(started);
        case "shell_input": {
          const { id, data } = request as { id: number; data: number[] };
          const text = new TextDecoder().decode(Uint8Array.from(data));
          typed.push(text);
          if (text.includes("get pods")) {
            const output = failing ?? "x".repeat(ROWS * 60);
            senders.get(id)?.(encoder.encode(output).buffer);
          }
          return Promise.resolve(null);
        }
        default:
          return Promise.resolve(null);
      }
    },
    subscribe: (
      command: string,
      request: unknown,
      onMessage: (message: never) => void,
    ) => {
      if (command === "shell_open") {
        const { id } = request as { id: number };
        const send = onMessage as (message: ShellMessage) => void;
        senders.set(id, send);
        queueMicrotask(() => {
          send({ state: "running" });
        });
      }
      if (command === "forwards_watch") {
        tell = onMessage as (event: ForwardEvent) => void;
      }
      return Promise.resolve(null);
    },
  };
  const probe = new Probe(inner);
  void probe.backend.subscribe("forwards_watch", null, () => undefined);
  const channel = (id: number) => {
    void probe.backend.subscribe(
      "shell_open",
      { id, cols: 80, rows: 24 },
      () => undefined,
    );
  };
  const workbench = {
    keys: { lookup: () => () => undefined },
    catalog: { find: () => ({ access: { environment } }) },
    editors: {
      open: (uri: string) => {
        log.push(`open ${uri}`);
      },
    },
    operations: {
      get asking() {
        return asking;
      },
    },
    quickAccess: {
      get session() {
        return pick && { pick };
      },
      accept: (item: { id: string }) => {
        log.push(`pick ${item.id}`);
        pick = undefined;
        return Promise.resolve();
      },
    },
    commands: {
      execute: async (id: string, _lookup: unknown, args: unknown) => {
        log.push(id);
        switch (id) {
          case "workbench.action.setContextEnvironment":
            environment = (args as { value: string }).value;
            break;
          case "k8s.shell.open":
            if (asks) {
              await new Promise<void>((resolve) => {
                asking = {
                  plan: { friction, question: "Open a shell in shell?" },
                  confirm: (text) => {
                    confirmed = text;
                    asking = undefined;
                    resolve();
                  },
                };
              });
            }
            channel(SHELL);
            break;
          case "k8s.forward.open":
            await new Promise<void>((resolve) => {
              pick = { items: [{ id: "53" }, { id: "8080" }] };
              const chosen = setInterval(() => {
                if (pick !== undefined) return;
                clearInterval(chosen);
                resolve();
              }, 1);
            });
            await probe.backend.invoke("forward_start", {} as never);
            break;
          case "k8s.terminal.new":
            await probe.backend.invoke("terminal_create", {} as never);
            channel(TERMINAL);
            break;
        }
        return true;
      },
    },
  };
  const written: [string, unknown][] = [];
  return {
    log,
    typed,
    written,
    confirmed: () => confirmed,
    run: () =>
      driveSessions(workbench as never, probe, {
        space: "s",
        context: "kind-twigo",
        list: "k8s-list://s/v1/pods",
        rows: ROWS,
        target,
        write: (name, value) => {
          written.push([name, value]);
          return Promise.resolve();
        },
      }),
  };
}

test("the sessions open in the order a person opens them, through the friction the context asks", async () => {
  const bench = fake();
  await bench.run();
  expect(bench.log).toEqual([
    "workbench.action.setContextEnvironment",
    "k8s.shell.open",
    "k8s.forward.open",
    "pick 8080",
    "k8s.terminal.new",
    "open k8s-list://s/v1/pods",
  ]);
  expect(bench.confirmed()).toBeUndefined();
  expect(bench.written[0]).toEqual([
    "sessions",
    {
      shell: { pod: "shell", question: "Open a shell in shell?" },
      forward: { target: "coredns-1", port: 8080, local: 8080 },
      terminal: { kind: "proxy", shell: "zsh" },
    },
  ]);
});

test("a dialog that asks for a name typed has it typed", async () => {
  const bench = fake({ friction: { kind: "typed", text: "kind-twigo" } });
  await bench.run();
  expect(bench.confirmed()).toBe("kind-twigo");
});

test("a shell that opens without a dialog fails the run, since its context is not guarded", async () => {
  await expect(fake({ asks: false }).run()).rejects.toThrow(
    "the shell ran without asking in a dialog",
  );
});

test("a port the pod does not offer fails the run, naming the ports it offers", async () => {
  const target = { ...TARGET, forward: { ...TARGET.forward, port: 9999 } };
  await expect(fake({ target }).run()).rejects.toThrow(
    "coredns-1 offers ports 53, 8080, not 9999",
  );
});

test("a local port that another process holds fails the run", async () => {
  const bench = fake({
    forward: { outcome: "busy", local: 8080, why: "inUse", free: 8081 },
  });
  await expect(bench.run()).rejects.toThrow(/local port 8080 must be free/);
});

test("a terminal that does not go through the policy proxy fails the run", async () => {
  const bench = fake({ terminal: { kind: "kubeconfig" } });
  await expect(bench.run()).rejects.toThrow(
    "the terminal does not go through the policy proxy",
  );
});

test("the terminal watches through the proxy and straight to the cluster in the order of the windows, each marked", async () => {
  const bench = fake();
  await bench.run();
  const kubectl = "'/usr/local/bin/kubectl'";
  const proxy = `${kubectl} get pods -A -w\r`;
  const direct = `${kubectl} --kubeconfig '/tmp/it'\\''s/kubeconfig' get pods -A -w\r`;
  expect(bench.typed).toEqual([proxy, "\x03", direct, "\x03", proxy]);
  const windows = bench.written
    .filter(([name]) => name.startsWith("watch"))
    .map(([name, value]) => [name, (value as { via: string }).via]);
  expect(windows).toEqual([
    ["watch-1", "proxy"],
    ["watched-1", "proxy"],
    ["watch-2", "direct"],
    ["watched-2", "direct"],
    ["watch-3", "direct"],
    ["watched-3", "direct"],
    ["watch-4", "proxy"],
    ["watched-4", "proxy"],
  ]);
}, 20_000);

test("a watch that never shows the pods fails with the end of what the terminal printed", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (now += 1000));
  const bench = fake({ failing: "zsh: command not found: kubectl\r\n" });
  await expect(bench.run()).rejects.toThrow(
    /first rows of the watch through the proxy within 90000 ms; the terminal's last output: "zsh: command not found: kubectl/,
  );
});
