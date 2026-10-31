import { expect, test } from "vitest";
import { IpcError, toIpcError } from "./error";

test("a Rust error keeps its kind and message", () => {
  const error = toIpcError({ kind: "forbidden", message: "no list on pods" });
  expect(error).toBeInstanceOf(IpcError);
  expect([error.kind, error.message]).toEqual(["forbidden", "no list on pods"]);
});

test("anything else, such as Tauri's unknown-command string, is internal", () => {
  expect(toIpcError("Command spaces_list not found").kind).toBe("internal");
  expect(toIpcError(new Error("boom")).message).toBe("boom");
});
