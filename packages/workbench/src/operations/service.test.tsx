import { act, cleanup, render, screen } from "@testing-library/react";
import { Trash2 } from "lucide-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  IpcError,
  type Backend,
  type Blocked,
  type OperationEvent,
  type Plan,
  type PlanRequest,
} from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { notify, Toaster } from "@twigo/ui";
import { testWorkbench } from "../testing";
import { WorkbenchView } from "../WorkbenchView";
import { COUNTING_DOWN, UNDOABLE, type Outcome } from "./service";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const LOOK = { icon: Trash2 };

const REQUEST: PlanRequest = {
  action: "delete",
  space: "dev",
  targets: [
    {
      gvr: { group: "", version: "v1", resource: "pods" },
      namespaced: true,
      namespace: "default",
      name: "web-1",
    },
  ],
};

function plan(friction: Plan["friction"]): Plan {
  return {
    id: 7,
    context: "dev",
    environment: "development",
    mode: "read-write",
    friction,
    question: "Delete pod web-1 in default from dev?",
    confirm: "Delete pod",
    destructive: true,
    consequences: ["Its replica set web-5d4f replaces it."],
    affected: [],
    kubectl: "kubectl --context dev delete pods web-1 -n default",
    doing: "Deleting pod web-1",
  };
}

/**
 * The mock backend whose bus answers with `planned` and runs it by telling
 * `events`, recording each bus command it is sent.
 */
function bus(planned: Plan | IpcError, events: OperationEvent[]) {
  const mock = createMockBackend("ready");
  const sent: { command: string; request: unknown }[] = [];
  let next = planned instanceof IpcError ? 0 : planned.id;
  const backend: Backend = {
    invoke(command, request) {
      if (command === "command_plan" || command === "command_cancel") {
        sent.push({ command, request });
        if (command === "command_cancel") return Promise.resolve(null as never);
        return planned instanceof IpcError
          ? Promise.reject(planned)
          : Promise.resolve({ ...planned, id: next++ } as never);
      }
      return mock.invoke(command, request);
    },
    subscribe(command, request, onMessage) {
      if (command !== "command_execute") {
        return mock.subscribe(command, request, onMessage);
      }
      sent.push({ command, request });
      setTimeout(() => {
        for (const event of events) onMessage(event);
      }, 10);
      return Promise.resolve(null as never);
    },
  };
  return { backend, sent };
}

async function started(planned: Plan | IpcError, events: OperationEvent[]) {
  const { backend, sent } = bus(planned, events);
  const workbench = await testWorkbench("ready", backend);
  const report = vi.spyOn(workbench, "report");
  const outcome = workbench.operations.run(REQUEST, LOOK);
  await act(() => vi.advanceTimersByTimeAsync(0));
  return { workbench, sent, report, outcome };
}

const commands = (sent: { command: string }[]) =>
  sent.map(({ command }) => command);

test("a cancel in the countdown sends nothing, and the countdown's end runs the plan", async () => {
  const cancelled = await started(plan({ kind: "countdown", seconds: 5 }), []);
  const { keys, operations } = cancelled.workbench;
  expect(keys.lookup(null)(COUNTING_DOWN)).toBe(true);
  await act(() => vi.advanceTimersByTimeAsync(4900));
  act(() => {
    operations.cancelCountdown();
  });
  await expect(cancelled.outcome).resolves.toEqual({ state: "cancelled" });
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(commands(cancelled.sent)).toEqual(["command_plan", "command_cancel"]);
  expect(keys.lookup(null)(COUNTING_DOWN)).toBe(false);

  const done = await started(plan({ kind: "countdown", seconds: 5 }), [
    { state: "running", text: "Waiting for pod web-1 to go" },
    { state: "done", text: "Deleted pod web-1", undoUntil: null },
  ]);
  await act(() => vi.advanceTimersByTimeAsync(4900));
  expect(commands(done.sent)).toEqual(["command_plan"]);
  await act(() => vi.advanceTimersByTimeAsync(100));
  expect(done.sent[1]).toEqual({
    command: "command_execute",
    request: { plan: 7, typed: null },
  });
  await act(() => vi.advanceTimersByTimeAsync(20));
  await expect(done.outcome).resolves.toEqual({ state: "done" });
  expect(done.workbench.operations.running).toEqual([]);
});

test("a dialog runs the plan with what was typed, and its cancel drops it", async () => {
  const typed = await started(plan({ kind: "typed", text: "dev" }), [
    { state: "done", text: "Deleted pod web-1", undoUntil: null },
  ]);
  const asking = typed.workbench.operations.asking;
  expect(asking?.plan.id).toBe(7);
  act(() => {
    asking?.confirm("dev");
  });
  expect(typed.workbench.operations.asking).toBeUndefined();
  await act(() => vi.advanceTimersByTimeAsync(20));
  await expect(typed.outcome).resolves.toEqual({ state: "done" });
  expect(typed.sent[1]?.request).toEqual({ plan: 7, typed: "dev" });

  const dropped = await started(plan({ kind: "confirm" }), []);
  act(() => {
    dropped.workbench.operations.asking?.cancel();
  });
  await expect(dropped.outcome).resolves.toEqual({ state: "cancelled" });
  expect(commands(dropped.sent)).toEqual(["command_plan", "command_cancel"]);
});

test("a wait shows until the run ends, and a stop asks Rust to stop it", async () => {
  const waiting = await started(plan({ kind: "atOnce" }), [
    { state: "running", text: "Waiting for namespace payments to go" },
  ]);
  await act(() => vi.advanceTimersByTimeAsync(20));
  const [running] = waiting.workbench.operations.running;
  expect(running?.text).toBe("Waiting for namespace payments to go");
  running?.stop();
  expect(waiting.sent[waiting.sent.length - 1]).toEqual({
    command: "command_cancel",
    request: 7,
  });
});

function blocked(source: Blocked["source"]): IpcError {
  return new IpcError(
    "permissions",
    "dev is read-only as Production by default, so Twigo did not send delete pods/web-1 in default",
    {
      context: "dev",
      mode: "read-only",
      source,
      class: "write",
      reason: "mode",
      verb: "delete",
      target: "pods/web-1 in default",
    },
  );
}

test("a refused plan runs nothing, and a lock the person may lift offers the unlock", async () => {
  const error = vi.spyOn(notify, "error");
  const refused = blocked({ kind: "environment", environment: "production" });
  const { workbench, sent, report, outcome } = await started(refused, []);
  await expect(outcome).resolves.toEqual({ state: "failed" } satisfies Outcome);
  expect(commands(sent)).toEqual(["command_plan"]);
  expect(report).not.toHaveBeenCalled();
  const [message, options] = error.mock.calls[0] ?? [];
  expect(message).toBe(refused.message);
  expect(options?.action?.label).toBe("Unlock for 15 minutes");
  const unlock = vi.spyOn(workbench.backend, "invoke");
  options?.action?.run();
  expect(unlock).toHaveBeenCalledWith("context_unlock", "dev");
});

test("a policy file's lock is only reported, as nothing in Twigo lifts it", async () => {
  const error = vi.spyOn(notify, "error");
  const refused = blocked({
    kind: "policyFile",
    file: "/etc/twigo/policy.json",
    pattern: "dev",
  });
  const { report, outcome } = await started(refused, []);
  await expect(outcome).resolves.toEqual({ state: "failed" });
  expect(report).toHaveBeenCalledWith(refused);
  expect(error.mock.calls.map(([, options]) => options?.action)).toEqual(
    error.mock.calls.map(() => undefined),
  );
});

test("a run that fails is reported", async () => {
  const error = {
    kind: "conflict" as const,
    message: "pod web-1 was replaced",
  };
  const { report, outcome } = await started(plan({ kind: "atOnce" }), [
    { state: "failed", error },
  ]);
  await act(() => vi.advanceTimersByTimeAsync(20));
  await expect(outcome).resolves.toEqual({ state: "failed" });
  expect(report).toHaveBeenCalledWith(error);
});

test("a second countdown of the same object replaces the first, and ⌘Z cancels only outside a text field", async () => {
  const first = await started(plan({ kind: "countdown", seconds: 5 }), []);
  const { workbench, sent } = first;
  const second = workbench.operations.run(REQUEST, LOOK);
  await act(() => vi.advanceTimersByTimeAsync(0));
  await expect(first.outcome).resolves.toEqual({ state: "cancelled" });
  expect(sent.map(({ command, request }) => [command, request])).toEqual([
    ["command_plan", REQUEST],
    ["command_plan", REQUEST],
    ["command_cancel", 7],
  ]);

  /** ⌘Z pressed in `target`, through the window's dispatch as the shell wires it. */
  const undo = (target: Element) => {
    const event = new KeyboardEvent("keydown", {
      code: "KeyZ",
      key: "z",
      metaKey: true,
      cancelable: true,
      bubbles: true,
    });
    let handled = false;
    target.addEventListener(
      "keydown",
      (seen) => {
        handled = workbench.keybindings.dispatch(seen as KeyboardEvent);
      },
      { once: true },
    );
    target.dispatchEvent(event);
    return handled;
  };
  const input = document.createElement("input");
  document.body.append(input);
  expect(undo(input)).toBe(false);
  input.remove();
  expect(undo(document.body)).toBe(true);
  await expect(second).resolves.toEqual({ state: "cancelled" });
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(commands(sent)).not.toContain("command_execute");
});

test("a second dialog cancels the first's plan", async () => {
  const first = await started(plan({ kind: "confirm" }), []);
  const second = first.workbench.operations.run(REQUEST, LOOK);
  await act(() => vi.advanceTimersByTimeAsync(0));
  await expect(first.outcome).resolves.toEqual({ state: "cancelled" });
  expect(first.workbench.operations.asking?.plan.id).toBe(8);
  expect(first.sent[first.sent.length - 1]).toEqual({
    command: "command_cancel",
    request: 7,
  });
  act(() => {
    first.workbench.operations.asking?.cancel();
  });
  await expect(second).resolves.toEqual({ state: "cancelled" });
});

test("a countdown that runs out runs its plan, though its toast's dismissal cancels", async () => {
  render(<Toaster />);
  const { sent, outcome } = await started(
    plan({ kind: "countdown", seconds: 5 }),
    [{ state: "done", text: "Deleted pod web-1", undoUntil: null }],
  );
  await act(() => vi.advanceTimersByTimeAsync(5000));
  await act(() => vi.advanceTimersByTimeAsync(1000));
  await expect(outcome).resolves.toEqual({ state: "done" });
  expect(commands(sent)).toEqual(["command_plan", "command_execute"]);
});

test("an action's undo is offered in its space while it lasts, and a later action ends it", async () => {
  render(<Toaster />);
  const until = Date.now() + 30_000;
  const scaled = await started(plan({ kind: "atOnce" }), [
    { state: "done", text: "Scaled deployment web to 5", undoUntil: until },
  ]);
  const { keys, operations } = scaled.workbench;
  await act(() => vi.advanceTimersByTimeAsync(20));
  await expect(scaled.outcome).resolves.toEqual({ state: "done" });
  expect(keys.lookup(null)(UNDOABLE)).toEqual(["dev"]);
  expect(document.body.textContent).toContain("Scaled deployment web to 5");
  expect(document.body.textContent).toContain("Undo");

  const undone = operations.undo("dev");
  await act(() => vi.advanceTimersByTimeAsync(20));
  await expect(undone).resolves.toEqual({ state: "done" });
  expect(scaled.sent.map(({ request }) => request)).toContainEqual({
    action: "undo",
    space: "dev",
  });
  expect(keys.lookup(null)(UNDOABLE)).toEqual([]);
  await expect(operations.undo("dev")).resolves.toEqual({ state: "cancelled" });
});

test("an undo nobody takes lasts its 30 s", async () => {
  vi.spyOn(notify, "undoable").mockReturnValue({ dismiss: vi.fn() });
  const until = Date.now() + 30_000;
  const scaled = await started(plan({ kind: "atOnce" }), [
    { state: "done", text: "Scaled deployment web to 5", undoUntil: until },
  ]);
  await act(() => vi.advanceTimersByTimeAsync(20));
  await scaled.outcome;
  const { keys, operations } = scaled.workbench;
  await act(() => vi.advanceTimersByTimeAsync(29_000));
  expect(keys.lookup(null)(UNDOABLE)).toEqual(["dev"]);
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(keys.lookup(null)(UNDOABLE)).toEqual([]);
  await expect(operations.undo("dev")).resolves.toEqual({ state: "cancelled" });
});

test("an action without an undo ends the one before it in its space", async () => {
  const events: OperationEvent[] = [
    {
      state: "done",
      text: "Scaled deployment web to 5",
      undoUntil: Date.now() + 30_000,
    },
  ];
  const { backend } = bus(plan({ kind: "atOnce" }), events);
  const workbench = await testWorkbench("ready", backend);
  const scaled = workbench.operations.run(REQUEST, LOOK);
  await act(() => vi.advanceTimersByTimeAsync(20));
  await scaled;
  expect(workbench.keys.lookup(null)(UNDOABLE)).toEqual(["dev"]);

  events.splice(0, events.length, {
    state: "done",
    text: "Restarted deployment web",
    undoUntil: null,
  });
  const restarted = workbench.operations.run(REQUEST, LOOK);
  await act(() => vi.advanceTimersByTimeAsync(20));
  await restarted;
  expect(workbench.keys.lookup(null)(UNDOABLE)).toEqual([]);
});

test("an undo's toast goes when it ends, and a refused run leaves it", async () => {
  const dismiss = vi.fn();
  vi.spyOn(notify, "undoable").mockReturnValue({ dismiss });
  const events: OperationEvent[] = [
    {
      state: "done",
      text: "Scaled deployment web to 5",
      undoUntil: Date.now() + 30_000,
    },
  ];
  const { backend } = bus(plan({ kind: "atOnce" }), events);
  const workbench = await testWorkbench("ready", backend);
  const scaled = workbench.operations.run(REQUEST, LOOK);
  await act(() => vi.advanceTimersByTimeAsync(20));
  await scaled;

  vi.spyOn(backend, "subscribe").mockRejectedValueOnce(
    new IpcError("conflict", "dev is guarded now"),
  );
  const refused = workbench.operations.run(REQUEST, LOOK);
  await act(() => vi.advanceTimersByTimeAsync(20));
  await expect(refused).resolves.toEqual({ state: "failed" });
  expect(workbench.keys.lookup(null)(UNDOABLE)).toEqual(["dev"]);
  expect(dismiss).not.toHaveBeenCalled();

  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(dismiss).toHaveBeenCalledOnce();
  expect(workbench.keys.lookup(null)(UNDOABLE)).toEqual([]);
});

test("a second ⌘Z while the undo goes does nothing", async () => {
  vi.spyOn(notify, "undoable").mockReturnValue({ dismiss: vi.fn() });
  const until = Date.now() + 30_000;
  const scaled = await started(plan({ kind: "atOnce" }), [
    { state: "done", text: "Scaled deployment web to 5", undoUntil: until },
  ]);
  await act(() => vi.advanceTimersByTimeAsync(20));
  await scaled.outcome;
  const { operations, keys, backend } = scaled.workbench;
  const invoke = vi
    .spyOn(backend, "invoke")
    .mockImplementationOnce(() => new Promise(() => undefined));
  void operations.undo("dev");
  await expect(operations.undo("dev")).resolves.toEqual({
    state: "cancelled",
  });
  expect(invoke).toHaveBeenCalledOnce();
  expect(keys.lookup(null)(UNDOABLE)).toEqual(["dev"]);
});

test("⌘Z cancels a countdown before it undoes, and undoes in a list otherwise", async () => {
  const workbench = await testWorkbench();
  const execute = vi
    .spyOn(workbench.commands, "execute")
    .mockResolvedValue(true);
  workbench.keys.set("listFocus", true);
  workbench.keys.set("space.id", "dev");
  workbench.keys.set(UNDOABLE, ["dev"]);
  const press = () =>
    workbench.keybindings.dispatch(
      new KeyboardEvent("keydown", { code: "KeyZ", metaKey: true }),
    );
  press();
  expect(execute).toHaveBeenLastCalledWith(
    "workbench.action.undo",
    expect.any(Function),
    undefined,
  );
  workbench.keys.set(COUNTING_DOWN, true);
  press();
  expect(execute).toHaveBeenLastCalledWith(
    "workbench.action.cancelCountdown",
    expect.any(Function),
    undefined,
  );
});

/**
 * A backend whose plans answer in turn with ids from 1, and whose runs tell
 * what `told` gives for their plan, after `after` ms.
 */
function scripted(
  told: Record<number, { after: number; events: OperationEvent[] }>,
) {
  const mock = createMockBackend("ready");
  let next = 0;
  const backend: Backend = {
    invoke(command, request) {
      if (command === "command_plan") {
        return Promise.resolve({
          ...plan({ kind: "atOnce" }),
          id: ++next,
        } as never);
      }
      if (command === "command_cancel") return Promise.resolve(null as never);
      return mock.invoke(command, request);
    },
    subscribe(command, request, onMessage) {
      if (command !== "command_execute") {
        return mock.subscribe(command, request, onMessage);
      }
      const { plan: id } = request as { plan: number };
      const run = told[id];
      setTimeout(() => {
        for (const event of run?.events ?? []) onMessage(event);
      }, run?.after ?? 0);
      return Promise.resolve(null as never);
    },
  };
  return backend;
}

test("the last action is the one that started last, whichever ends first", async () => {
  const offered = vi
    .spyOn(notify, "undoable")
    .mockReturnValue({ dismiss: vi.fn() });
  const until = Date.now() + 30_000;
  const done = (text: string) => ({
    state: "done" as const,
    text,
    undoUntil: until,
  });
  const workbench = await testWorkbench(
    "ready",
    scripted({
      1: { after: 100, events: [done("Scaled deployment web to 5")] },
      2: { after: 10, events: [done("Cordoned node n")] },
    }),
  );
  const first = workbench.operations.run(REQUEST, LOOK);
  await act(() => vi.advanceTimersByTimeAsync(1));
  const second = workbench.operations.run(REQUEST, LOOK);
  await act(() => vi.advanceTimersByTimeAsync(200));
  await Promise.all([first, second]);
  expect(offered.mock.calls.map(([props]) => props.message)).toEqual([
    "Cordoned node n",
  ]);
  expect(workbench.keys.lookup(null)(UNDOABLE)).toEqual(["dev"]);
});

test("an undo Rust refused leaves the undo to try again", async () => {
  vi.spyOn(notify, "undoable").mockReturnValue({ dismiss: vi.fn() });
  const until = Date.now() + 30_000;
  const scaled = await started(plan({ kind: "atOnce" }), [
    { state: "done", text: "Scaled deployment web to 5", undoUntil: until },
  ]);
  await act(() => vi.advanceTimersByTimeAsync(20));
  await scaled.outcome;
  const { operations, keys, backend } = scaled.workbench;
  vi.spyOn(backend, "invoke").mockRejectedValueOnce(
    new IpcError("conflict", "prod-eu is read-only now"),
  );
  await expect(operations.undo("dev")).resolves.toEqual({ state: "failed" });
  expect(keys.lookup(null)(UNDOABLE)).toEqual(["dev"]);
});

test("an undo's button takes something away only when its plan says so, and a cancel keeps the undo", async () => {
  vi.spyOn(notify, "undoable").mockReturnValue({ dismiss: vi.fn() });
  const until = Date.now() + 30_000;
  const scaled = await started(plan({ kind: "atOnce" }), [
    { state: "done", text: "Scaled deployment web to 2", undoUntil: until },
  ]);
  await act(() => vi.advanceTimersByTimeAsync(20));
  await scaled.outcome;
  const { workbench } = scaled;
  render(<WorkbenchView workbench={workbench} />);
  const button = () => screen.getByRole("button", { name: /^Undo/ });
  for (const destructive of [true, false]) {
    vi.spyOn(workbench.backend, "invoke").mockResolvedValueOnce({
      ...plan({ kind: "confirm" }),
      id: destructive ? 9 : 10,
      confirm: "Undo",
      destructive,
    });
    const undone = workbench.operations.undo("dev");
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(button().className.includes("bg-destructive")).toBe(destructive);
    act(() => {
      workbench.operations.asking?.cancel();
    });
    await expect(undone).resolves.toEqual({ state: "cancelled" });
    expect(workbench.keys.lookup(null)(UNDOABLE)).toEqual(["dev"]);
  }
});

test("an undo's dialog closes when the undo ends", async () => {
  vi.spyOn(notify, "undoable").mockReturnValue({ dismiss: vi.fn() });
  const until = Date.now() + 30_000;
  const scaled = await started(plan({ kind: "atOnce" }), [
    { state: "done", text: "Scaled deployment web to 2", undoUntil: until },
  ]);
  await act(() => vi.advanceTimersByTimeAsync(20));
  await scaled.outcome;
  const { operations, backend } = scaled.workbench;
  vi.spyOn(backend, "invoke").mockResolvedValueOnce({
    ...plan({ kind: "confirm" }),
    id: 9,
  });
  const undone = operations.undo("dev");
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(operations.asking?.plan.id).toBe(9);
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(operations.asking).toBeUndefined();
  await expect(undone).resolves.toEqual({ state: "cancelled" });
});

test("a done run whose undo is not offered still says so", async () => {
  const success = vi.spyOn(notify, "success");
  vi.spyOn(notify, "undoable").mockReturnValue({ dismiss: vi.fn() });
  const until = Date.now() + 30_000;
  const scaled = await started(plan({ kind: "atOnce" }), [
    { state: "done", text: "Scaled deployment web to 5", undoUntil: until },
  ]);
  await act(() => vi.advanceTimersByTimeAsync(20));
  await scaled.outcome;
  expect(success).not.toHaveBeenCalled();
  const undone = scaled.workbench.operations.undo("dev");
  await act(() => vi.advanceTimersByTimeAsync(20));
  await undone;
  expect(success).toHaveBeenCalledWith("Scaled deployment web to 5");
});
