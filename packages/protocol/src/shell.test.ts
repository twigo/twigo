import { expect, test, vi } from "vitest";
import type { Backend } from "./backend";
import { IpcError } from "./error";
import type { ShellEvent, ShellMessage } from "./generated";
import { ShellSession, type ShellOutput } from "./shell";

const OPEN = { id: 7, cols: 80, rows: 24 };

type Call = [string, unknown, () => void, (error: unknown) => void];

/** A backend whose plain calls wait until the test answers them. */
function fakeBackend() {
  let send: ((message: ShellMessage) => void) | undefined;
  let refuse: ((error: unknown) => void) | undefined;
  const calls: Call[] = [];
  const backend: Backend = {
    invoke(command, request) {
      return new Promise((resolve, reject) => {
        calls.push([command, request, () => resolve(null), reject]);
      });
    },
    subscribe(_command, _request, onMessage) {
      send = onMessage;
      return new Promise((_resolve, reject) => {
        refuse = reject;
      });
    },
  };
  const sent = (command: string) =>
    calls.filter(([name]) => name === command).map(([, request]) => request);
  return {
    backend,
    calls,
    sent,
    send: (message: ShellMessage) => {
      send?.(message);
    },
    refuse: (error: unknown) => {
      refuse?.(error);
    },
    answer: async (index: number) => {
      calls[index]?.[2]();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function opened(output = vi.fn<ShellOutput>()) {
  const fake = fakeBackend();
  const report = vi.fn();
  const session = new ShellSession(fake.backend, OPEN, output, report);
  return { fake, session, output, report };
}

const running: ShellEvent = { state: "running" };

const frame = (text: string) => new TextEncoder().encode(text).buffer;

test("what is typed while a call is in flight goes in the next one, in order", async () => {
  const { fake, session } = opened();
  fake.send(running);
  session.input(new Uint8Array([97]));
  session.input(new Uint8Array([98]));
  session.input(new Uint8Array([99, 100]));
  expect(fake.sent("shell_input")).toEqual([{ id: 7, data: [97] }]);
  await fake.answer(0);
  expect(fake.sent("shell_input")).toEqual([
    { id: 7, data: [97] },
    { id: 7, data: [98, 99, 100] },
  ]);
  session.input(new Uint8Array([101]));
  expect(fake.sent("shell_input")).toHaveLength(2);
  await fake.answer(1);
  expect(fake.sent("shell_input")[2]).toEqual({ id: 7, data: [101] });
});

test("the next input goes after a call failed too, and the failure is reported", async () => {
  const { fake, session, report } = opened();
  fake.send(running);
  session.input(new Uint8Array([97]));
  session.input(new Uint8Array([98]));
  const failure = new IpcError("notFound", "no shell");
  fake.calls[0]?.[3](failure);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(report).toHaveBeenCalledWith(failure);
  expect(fake.sent("shell_input")).toEqual([
    { id: 7, data: [97] },
    { id: 7, data: [98] },
  ]);
});

test("nothing is sent before the shell runs or after it ended", () => {
  const { fake, session } = opened();
  session.input(new Uint8Array([97]));
  fake.send({ state: "queued" });
  session.input(new Uint8Array([97]));
  fake.send({ state: "connecting" });
  session.input(new Uint8Array([97]));
  fake.send(running);
  fake.send({ state: "ended", end: { reason: "exited", code: 0 } });
  session.input(new Uint8Array([97]));
  expect(fake.sent("shell_input")).toEqual([]);
});

test("acks count the bytes the terminal parsed, and wait for its callback", async () => {
  const { fake, session, output } = opened();
  fake.send(frame("hello"));
  fake.send(frame("world!!"));
  expect(output).toHaveBeenCalledTimes(2);
  expect(Array.from(output.mock.calls[0]?.[0] ?? [])).toEqual([
    104, 101, 108, 108, 111,
  ]);
  expect(fake.sent("shell_ack")).toEqual([]);
  output.mock.calls[0]?.[1]();
  expect(fake.sent("shell_ack")).toEqual([{ id: 7, bytes: 5 }]);
  output.mock.calls[1]?.[1]();
  expect(fake.sent("shell_ack")).toHaveLength(1);
  await fake.answer(0);
  expect(fake.sent("shell_ack")).toEqual([
    { id: 7, bytes: 5 },
    { id: 7, bytes: 7 },
  ]);
  expect(session.getSnapshot()).toEqual({ state: "connecting" });
});

test("acks gathered while one is in flight are summed", async () => {
  const { fake, output } = opened();
  for (const text of ["a", "bb", "ccc", "dddd"]) fake.send(frame(text));
  output.mock.calls[0]?.[1]();
  output.mock.calls[1]?.[1]();
  output.mock.calls[2]?.[1]();
  output.mock.calls[3]?.[1]();
  await fake.answer(0);
  expect(fake.sent("shell_ack")).toEqual([
    { id: 7, bytes: 1 },
    { id: 7, bytes: 9 },
  ]);
});

test("each event is the state, and ended comes last", () => {
  const { fake, session, output } = opened();
  const seen: ShellEvent[] = [];
  session.subscribe(() => {
    seen.push(session.getSnapshot());
  });
  expect(session.getSnapshot()).toEqual({ state: "connecting" });
  fake.send({ state: "queued" });
  fake.send({ state: "connecting" });
  fake.send(running);
  fake.send(frame("bye"));
  const end = { reason: "exited", code: 3 } as const;
  fake.send({ state: "ended", end });
  fake.send(frame("late"));
  fake.send(running);
  expect(seen.map(({ state }) => state)).toEqual([
    "queued",
    "connecting",
    "running",
    "ended",
  ]);
  expect(session.getSnapshot()).toEqual({ state: "ended", end });
  expect(output).toHaveBeenCalledTimes(1);
});

test("a shell that could not be opened ends as failed, in the error's words", async () => {
  const { fake, session } = opened();
  fake.refuse(new IpcError("notFound", "no plan 4 waits to open a shell"));
  await Promise.resolve();
  await Promise.resolve();
  expect(session.getSnapshot()).toMatchObject({
    state: "ended",
    end: {
      reason: "failed",
      error: { kind: "notFound", message: "no plan 4 waits to open a shell" },
    },
  });
});

test("a resize that changes nothing sends nothing, and one that does goes once the shell runs", async () => {
  const { fake, session } = opened();
  session.resize(80, 24);
  fake.send(running);
  session.resize(80, 24);
  expect(fake.sent("shell_resize")).toEqual([]);
  session.resize(100, 30);
  expect(fake.sent("shell_resize")).toEqual([{ id: 7, cols: 100, rows: 30 }]);
  session.resize(120, 40);
  session.resize(100, 30);
  expect(fake.sent("shell_resize")).toHaveLength(1);
  await fake.answer(0);
  expect(fake.sent("shell_resize")).toEqual([{ id: 7, cols: 100, rows: 30 }]);
});

test("a size changed while the shell connects goes when it runs", () => {
  const { fake, session } = opened();
  session.resize(90, 20);
  expect(fake.sent("shell_resize")).toEqual([]);
  fake.send({ state: "queued" });
  fake.send(running);
  expect(fake.sent("shell_resize")).toEqual([{ id: 7, cols: 90, rows: 20 }]);
});

test("closing tells Rust once, and stops what came after", () => {
  const { fake, session, output } = opened();
  fake.send(running);
  session.close();
  session.close();
  fake.send(frame("late"));
  session.input(new Uint8Array([97]));
  expect(fake.sent("shell_close")).toEqual([7]);
  expect(output).not.toHaveBeenCalled();
  expect(fake.sent("shell_input")).toEqual([]);
});
