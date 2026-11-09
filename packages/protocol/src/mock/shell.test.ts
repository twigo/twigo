import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { IpcError } from "../error";
import type { Backend } from "../backend";
import type {
  ShellEvent,
  ShellKind,
  ShellMessage,
  ShellTarget,
} from "../generated";
import { SHELL_FRAME_BYTES, SHELL_HIGH_WATER, SHELL_LOW_WATER } from "../shell";
import { Cluster } from "./cluster";
import { POD_COUNT } from "./fixtures";
import { createMockBackend, type MockScenario } from "./index";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function answered<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(0);
  return promise;
}

async function refused(promise: Promise<unknown>): Promise<IpcError> {
  const caught = promise.then(
    () => {
      throw new Error("it was not refused");
    },
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(0);
  const error = await caught;
  expect(error).toBeInstanceOf(IpcError);
  return error as IpcError;
}

/** The first running pod of a context, as the mock backend makes the same ones. */
function runningPod(context: string) {
  const found = new Cluster(context, POD_COUNT[context] ?? 0, 0).pods.find(
    (candidate) => candidate.status === "Running",
  );
  if (!found) throw new Error(`${context} has no running pod`);
  return found;
}

function targetOf(space: string, container = "api"): ShellTarget {
  const { namespace, name } = runningPod(space);
  return { space, namespace, pod: name, container };
}

interface Opened {
  readonly backend: Backend;
  readonly id: number;
  readonly messages: ShellMessage[];
  readonly events: ShellEvent[];
  /** The output so far as text. */
  readonly text: () => string;
  readonly frames: () => ArrayBuffer[];
  readonly type: (text: string) => Promise<void>;
}

/** Plans and runs a shell in `qa`, read-write, then opens its session at `cols` by `rows`. */
async function openShell(
  scenario: MockScenario = "live",
  kind: ShellKind = "shell",
  space = "qa",
): Promise<Opened> {
  const backend = createMockBackend(scenario);
  await answered(backend.invoke("space_open", space));
  const plan = await answered(
    backend.invoke("command_plan", {
      action: "shell",
      target: targetOf(space),
      kind,
    }),
  );
  let id = 0;
  await answered(
    backend.subscribe(
      "command_execute",
      { plan: plan.id, typed: plan.friction.kind === "typed" ? space : null },
      (event) => {
        if (event.state === "session") id = event.id;
      },
    ),
  );
  await vi.advanceTimersByTimeAsync(10);
  const messages: ShellMessage[] = [];
  await answered(
    backend.subscribe("shell_open", { id, cols: 100, rows: 30 }, (message) => {
      messages.push(message);
    }),
  );
  const frames = () =>
    messages.filter(
      (message): message is ArrayBuffer => "byteLength" in message,
    );
  return {
    backend,
    id,
    messages,
    events: [],
    frames,
    text: () =>
      frames()
        .map((frame) => new TextDecoder().decode(frame))
        .join(""),
    type: async (text) => {
      await answered(
        backend.invoke("shell_input", {
          id,
          data: Array.from(new TextEncoder().encode(text)),
        }),
      );
    },
  };
}

const states = (messages: readonly ShellMessage[]) =>
  messages.flatMap((message) => ("state" in message ? [message] : []));

test("a pod's running containers come with the default first, and one container where the scenario says", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "qa"));
  const { namespace, pod } = targetOf("qa");
  const request = { space: "qa", namespace, pod };
  const many = await answered(backend.invoke("shell_containers", request));
  expect(many.containers.length).toBeGreaterThanOrEqual(2);
  expect(many.default).toBe(many.containers[0]);

  const one = createMockBackend("shellOneContainer");
  await answered(one.invoke("space_open", "qa"));
  expect(
    (await answered(one.invoke("shell_containers", request))).containers,
  ).toHaveLength(1);
});

test("a pod that runs nothing is refused in words, and one that is not there is not found", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "qa"));
  const pending = new Cluster("qa", POD_COUNT.qa ?? 0, 0).pods.find(
    (candidate) => candidate.status !== "Running",
  );
  if (!pending) throw new Error("qa has no pod that is not running");
  const error = await refused(
    backend.invoke("shell_containers", {
      space: "qa",
      namespace: pending.namespace,
      pod: pending.name,
    }),
  );
  expect(error.kind).toBe("invalidInput");
  expect(error.message).toBe(
    `pod ${pending.name} is ${pending.status}, so it runs no container to open a shell in`,
  );
  const missing = await refused(
    backend.invoke("shell_containers", {
      space: "qa",
      namespace: "default",
      pod: "nothing-here",
    }),
  );
  expect(missing.kind).toBe("notFound");
});

test("a shell asks as exec does: at once in read-write, to confirm in guarded, refused in read-only", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "qa"));
  const plan = (space: string) =>
    backend.invoke("command_plan", {
      action: "shell",
      target: targetOf(space),
      kind: "shell",
    });
  expect((await answered(plan("qa"))).friction).toEqual({ kind: "atOnce" });
  const guarded = await answered(plan("staging"));
  expect(guarded.friction).toEqual({ kind: "confirm" });
  const { namespace, pod } = targetOf("staging");
  expect(guarded.kubectl).toBe(
    `kubectl --context staging exec -it ${pod} -n ${namespace} -c api -- sh -c 'export TERM=xterm-256color; command -v bash >/dev/null && exec bash || exec sh'`,
  );
  const readOnly = await refused(plan("prod-eu"));
  expect(readOnly.kind).toBe("permissions");
  expect(readOnly.blocked).toMatchObject({
    class: "exec",
    mode: "read-only",
    context: "prod-eu",
  });
});

test("an attach is planned apart from a shell, and a container that does not run is refused", async () => {
  const backend = createMockBackend("live");
  await answered(backend.invoke("space_open", "qa"));
  const attach = await answered(
    backend.invoke("command_plan", {
      action: "shell",
      target: targetOf("qa"),
      kind: "attach",
    }),
  );
  expect(attach.confirm).toBe("Attach");
  const { namespace, pod } = targetOf("qa");
  expect(attach.kubectl).toBe(
    `kubectl --context qa attach -it ${pod} -n ${namespace} -c api`,
  );
  const error = await refused(
    backend.invoke("command_plan", {
      action: "shell",
      target: targetOf("qa", "nothing"),
      kind: "shell",
    }),
  );
  expect(error.kind).toBe("notFound");
});

test("a run answers with a session that nothing starts until it is opened, once", async () => {
  const shell = await openShell();
  expect(shell.id).toBeGreaterThan(0);
  const again = await refused(
    shell.backend.subscribe(
      "shell_open",
      { id: shell.id, cols: 80, rows: 24 },
      () => undefined,
    ),
  );
  expect(again.kind).toBe("conflict");
  const unknown = await refused(
    shell.backend.subscribe(
      "shell_open",
      { id: 9999, cols: 80, rows: 24 },
      () => undefined,
    ),
  );
  expect(unknown.kind).toBe("notFound");
});

test("it connects, runs and shows a prompt with the pod and the container", async () => {
  const shell = await openShell();
  await vi.advanceTimersByTimeAsync(500);
  expect(states(shell.messages).map(({ state }) => state)).toEqual([
    "connecting",
    "running",
  ]);
  const { pod } = targetOf("qa");
  expect(shell.text()).toContain(`root@${pod}`);
  expect(shell.text()).toContain("[api]");
});

test("typed lines are echoed and run: echo, ls and the last size stty reads", async () => {
  const shell = await openShell();
  await vi.advanceTimersByTimeAsync(500);
  await shell.type("echo héllo 世界\r");
  expect(shell.text()).toContain("echo héllo 世界\r\nhéllo 世界\r\n");
  await shell.type("ls\r");
  expect(shell.text()).toContain("\x1b[1;34mbin\x1b[0m");
  expect(shell.text()).toContain("журнал.log");
  await shell.type("stty size\r");
  expect(shell.text()).toContain("30 100\r\n");
  await answered(
    shell.backend.invoke("shell_resize", { id: shell.id, cols: 132, rows: 40 }),
  );
  await shell.type("stty size\r");
  expect(shell.text()).toContain("40 132\r\n");
  await shell.type("nosuch\r");
  expect(shell.text()).toContain("sh: 1: nosuch: not found");
});

test("a backspace erases what was typed, and a character split between two calls is one", async () => {
  const shell = await openShell();
  await vi.advanceTimersByTimeAsync(500);
  await shell.type("ecx\x7fho ok\r");
  expect(shell.text()).toContain("\b \b");
  expect(shell.text()).toContain("ecx\b \bho ok\r\nok\r\n");
  const bytes = Array.from(new TextEncoder().encode("echo й\r"));
  const cut = bytes.indexOf(0xd0) + 1;
  for (const part of [bytes.slice(0, cut), bytes.slice(cut)]) {
    await answered(
      shell.backend.invoke("shell_input", { id: shell.id, data: part }),
    );
  }
  expect(shell.text()).toContain("й\r\nй\r\n");
});

test("a pasted newline does not run what was pasted, and Enter does", async () => {
  const shell = await openShell();
  await vi.advanceTimersByTimeAsync(500);
  expect(shell.text()).toContain("\x1b[?2004h");
  await shell.type("\x1b[200~echo one\necho two\x1b[201~");
  expect(shell.text()).not.toContain("one\r\n\x1b");
  expect(shell.text()).not.toMatch(/\r\none\r\n/);
  await shell.type("\r");
  expect(shell.text()).toMatch(/\r\none\r\n/);
  expect(shell.text()).toMatch(/\r\ntwo\r\n/);
});

test("exit N ends the session with its code after the output, and Ctrl-D on an empty line ends it with 0", async () => {
  const shell = await openShell();
  await vi.advanceTimersByTimeAsync(500);
  await shell.type("exit 3\r");
  const last = shell.messages[shell.messages.length - 1];
  expect(last).toEqual({ state: "ended", end: { reason: "exited", code: 3 } });
  expect(shell.text()).toContain("exit\r\n");
  const refusedInput = await refused(
    shell.backend.invoke("shell_input", { id: shell.id, data: [97] }),
  );
  expect(refusedInput.kind).toBe("conflict");

  const other = await openShell();
  await vi.advanceTimersByTimeAsync(500);
  await other.type("\x04");
  expect(other.messages[other.messages.length - 1]).toEqual({
    state: "ended",
    end: { reason: "exited", code: 0 },
  });
});

test("yes floods at most 64 KiB a frame, stops at 256 KiB unacknowledged and starts again below 64 KiB", async () => {
  const shell = await openShell();
  await vi.advanceTimersByTimeAsync(500);
  await shell.type("yes\r");
  await vi.advanceTimersByTimeAsync(1000);
  const sizes = () => shell.frames().map((frame) => frame.byteLength);
  const flood = () => sizes().slice(2);
  expect(Math.max(...flood())).toBeLessThanOrEqual(SHELL_FRAME_BYTES);
  const total = () => sizes().reduce((sum, size) => sum + size, 0);
  expect(total()).toBeGreaterThanOrEqual(SHELL_HIGH_WATER);
  expect(total()).toBeLessThan(SHELL_HIGH_WATER + SHELL_FRAME_BYTES);
  const stopped = shell.frames().length;
  await vi.advanceTimersByTimeAsync(1000);
  expect(shell.frames()).toHaveLength(stopped);

  let unacked = total();
  const ack = async (bytes: number) => {
    unacked -= bytes;
    await answered(shell.backend.invoke("shell_ack", { id: shell.id, bytes }));
    await vi.advanceTimersByTimeAsync(100);
  };
  await ack(unacked - SHELL_LOW_WATER);
  expect(shell.frames()).toHaveLength(stopped);
  await ack(1);
  expect(shell.frames().length).toBeGreaterThan(stopped);
  expect(shell.frames()).not.toHaveLength(stopped);
});

test("Ctrl-C stops yes and shows the prompt again", async () => {
  const shell = await openShell();
  await vi.advanceTimersByTimeAsync(500);
  await shell.type("yes\r");
  await vi.advanceTimersByTimeAsync(100);
  await shell.type("\x03");
  const after = shell.frames().length;
  await answered(
    shell.backend.invoke("shell_ack", { id: shell.id, bytes: 10 ** 7 }),
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(shell.frames()).toHaveLength(after);
  expect(shell.text()).toMatch(/\^C\r\n.*# $/);
});

test("an attach joins a process that writes on its own, and Ctrl-C ends it", async () => {
  const shell = await openShell("live", "attach");
  await vi.advanceTimersByTimeAsync(2500);
  expect(shell.text()).toContain("If you don't see a command prompt");
  expect(shell.text().match(/handled GET \/healthz 200/g)).toHaveLength(2);
  await shell.type("\x03");
  expect(shell.messages[shell.messages.length - 1]).toEqual({
    state: "ended",
    end: { reason: "detached" },
  });
});

test("a queued shell waits 5 s for its place", async () => {
  const shell = await openShell("shellQueued");
  await vi.advanceTimersByTimeAsync(4000);
  expect(states(shell.messages)).toEqual([{ state: "queued" }]);
  await vi.advanceTimersByTimeAsync(1500);
  expect(states(shell.messages).map(({ state }) => state)).toEqual([
    "queued",
    "connecting",
    "running",
  ]);
});

test("a container with no shell ends in its runtime's words before any output", async () => {
  const shell = await openShell("shellNoShell");
  await vi.advanceTimersByTimeAsync(500);
  const [connecting, ended, ...more] = shell.messages;
  expect(connecting).toEqual({ state: "connecting" });
  expect(ended).toMatchObject({
    state: "ended",
    end: { reason: "noShell" },
  });
  expect(JSON.stringify(ended)).toContain("executable file not found");
  expect(more).toEqual([]);
});

test("a lost connection ends it 8 s in, and a relock does too with the context read-only", async () => {
  const lost = await openShell("shellLost");
  await vi.advanceTimersByTimeAsync(7500);
  expect(lost.messages[lost.messages.length - 1]).not.toMatchObject({
    state: "ended",
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(lost.messages[lost.messages.length - 1]).toEqual({
    state: "ended",
    end: { reason: "connectionLost" },
  });

  const relocked = await openShell("shellRelocked");
  await vi.advanceTimersByTimeAsync(8500);
  expect(relocked.messages[relocked.messages.length - 1]).toEqual({
    state: "ended",
    end: { reason: "relocked" },
  });
  const plan = await refused(
    relocked.backend.invoke("command_plan", {
      action: "shell",
      target: targetOf("qa"),
      kind: "shell",
    }),
  );
  expect(plan.kind).toBe("permissions");
});

test("closing a session frees it, and a closed one is not found", async () => {
  const shell = await openShell();
  await answered(shell.backend.invoke("shell_close", shell.id));
  const error = await refused(
    shell.backend.invoke("shell_input", { id: shell.id, data: [97] }),
  );
  expect(error.kind).toBe("notFound");
  await vi.advanceTimersByTimeAsync(10_000);
});
