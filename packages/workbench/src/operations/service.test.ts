import { act } from "@testing-library/react";
import { Trash2 } from "lucide-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  IpcError,
  type Backend,
  type OperationEvent,
  type Plan,
  type PlanRequest,
} from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { testWorkbench } from "../testing";
import { COUNTING_DOWN, type Outcome } from "./service";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

const LOOK = { icon: Trash2, destructive: true };

const REQUEST: PlanRequest = {
  action: "delete",
  space: "dev",
  target: {
    gvr: { group: "", version: "v1", resource: "pods" },
    namespaced: true,
    namespace: "default",
    name: "web-1",
  },
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
    consequences: ["Its replica set web-5d4f replaces it."],
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
    { state: "done", text: "Deleted pod web-1" },
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
    { state: "done", text: "Deleted pod web-1" },
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

test("a refused plan is reported and nothing runs", async () => {
  const refused = new IpcError(
    "permissions",
    "dev is read-only by your choice, so Twigo did not send delete pods/web-1 in default",
  );
  const { sent, report, outcome } = await started(refused, []);
  await expect(outcome).resolves.toEqual({ state: "failed" } satisfies Outcome);
  expect(report).toHaveBeenCalledWith(refused);
  expect(commands(sent)).toEqual(["command_plan"]);
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
