import { afterEach, expect, test, vi } from "vitest";
import { IpcError, type Backend, type RequestOf } from "@twigo/protocol";
import { logWebviewErrors } from "./diagnostics";

type Entry = RequestOf<"diagnostics_log">;
type Listener = (event: Event) => void;

afterEach(() => {
  vi.restoreAllMocks();
});

function logging(refuse = false) {
  const sent: Entry[] = [];
  const invoke = (_command: string, entry: Entry) => {
    sent.push(entry);
    return refuse ? Promise.reject(new Error("no log")) : Promise.resolve(null);
  };
  const listeners = new Map<string, Listener>();
  vi.spyOn(window, "addEventListener").mockImplementation(
    (type: string, listener: unknown) => {
      listeners.set(type, listener as Listener);
    },
  );
  const log = logWebviewErrors({ invoke } as Pick<Backend, "invoke">);
  const fire = (type: string, event: object) => {
    listeners.get(type)?.(Object.assign(new Event(type), event));
  };
  return { sent, log, fire };
}

test("an error the page did not catch is sent with its stack and what caught it", () => {
  const { sent, fire } = logging();
  const error = new TypeError("x is undefined");
  fire("error", { error, message: "Uncaught TypeError" });
  expect(sent).toEqual([
    {
      level: "error",
      message: "x is undefined",
      stack: error.stack,
      source: "error",
    },
  ]);
});

test("a rejection nobody handled is sent, and an IpcError by its code alone, in its message and in its stack", () => {
  const { sent, fire } = logging();
  const refused = new IpcError(
    "server.invalid",
    'Secret "db" is invalid: data.password: Invalid value: "hunter2"',
  );
  fire("unhandledrejection", { reason: refused });
  fire("unhandledrejection", { reason: "plain words" });
  expect(sent.map(({ message, source }) => [message, source])).toEqual([
    ["server.invalid", "unhandledrejection"],
    ["plain words", "unhandledrejection"],
  ]);
  expect(JSON.stringify(sent)).not.toContain("hunter2");
});

test("the same error is sent once and counted, the count reaching the log as it doubles", () => {
  const { sent, fire } = logging();
  const error = new Error("again");
  for (let n = 0; n < 9; n++) fire("error", { error });
  expect(sent.map(({ level, message }) => [level, message])).toEqual([
    ["error", "again"],
    ["info", "repeated 2 times: again"],
    ["info", "repeated 4 times: again"],
    ["info", "repeated 8 times: again"],
  ]);
  fire("error", { error: new Error("another") });
  expect(sent[sent.length - 1]?.message).toBe("another");
});

test("what React's root catches is sent with its component stack and its own source name, and what it recovers from as a warning", () => {
  const { sent, log } = logging();
  const error = new Error("boom");
  log.root.onCaughtError?.(error, { componentStack: "\n    at Pane" });
  log.root.onUncaughtError?.(error, { componentStack: "\n    at Root" });
  log.root.onRecoverableError?.(error, { componentStack: "\n    at List" });
  expect(sent.map(({ level, source }) => [level, source])).toEqual([
    ["error", "onCaughtError"],
    ["error", "onUncaughtError"],
    ["warn", "onRecoverableError"],
  ]);
  expect(sent[0]?.stack).toContain("component stack:\n    at Pane");
});

test("a log that cannot be reached swallows the failure instead of raising another rejection", async () => {
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  const { sent, fire } = logging(true);
  fire("error", { error: new Error("nobody hears it") });
  await new Promise((resolve) => setTimeout(resolve, 10));
  process.off("unhandledRejection", unhandled);
  expect(sent).toHaveLength(1);
  expect(unhandled).not.toHaveBeenCalled();
});
