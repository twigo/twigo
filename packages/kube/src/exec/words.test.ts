import { expect, test } from "vitest";
import { ending } from "./words";

test("a shell ended by a signal says which, beside the exit codes' words", () => {
  expect(ending({ reason: "signaled", signal: "KILL" })).toEqual({
    title: "Session ended by SIGKILL.",
    label: "SIGKILL",
    tone: "warn",
  });
  expect(ending({ reason: "exited", code: 1 }).label).toBe("Exit 1");
});
