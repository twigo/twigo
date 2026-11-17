import { expect, test } from "vitest";
import type { ShellEnd } from "@twigo/protocol";
import { ending, sessionState } from "./words";

test("a shell ended by a signal says which, beside the exit codes' words", () => {
  expect(ending({ reason: "signaled", signal: "KILL" })).toEqual({
    title: "Session ended by SIGKILL.",
    label: "SIGKILL",
    tone: "warn",
  });
  expect(ending({ reason: "exited", code: 1 }).label).toBe("Exit 1");
});

test("a shell's tab says connecting until it runs, and ended for a layout's tab that nothing started", () => {
  expect(sessionState({ state: "queued" })).toBe("connecting");
  expect(sessionState({ state: "connecting" })).toBe("connecting");
  expect(sessionState({ state: "running" })).toBe("running");
  expect(sessionState({ state: "restored" })).toBe("ended");
});

test.each<[ShellEnd, "ended" | "failed"]>([
  [{ reason: "exited", code: 0 }, "ended"],
  [{ reason: "exited", code: 1 }, "ended"],
  [{ reason: "signaled", signal: "KILL" }, "ended"],
  [{ reason: "detached" }, "ended"],
  [{ reason: "noShell", message: "no sh" }, "ended"],
  [{ reason: "relocked" }, "ended"],
  [{ reason: "connectionLost" }, "failed"],
  [
    {
      reason: "failed",
      error: { kind: "unavailable", message: "broken" },
    },
    "failed",
  ],
])(
  "a shell that ended as %j is %s in its tab, as the tone it is worded in says",
  (end, state) => {
    expect(sessionState({ state: "ended", end })).toBe(state);
  },
);
