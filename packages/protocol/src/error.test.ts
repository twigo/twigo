import { expect, test } from "vitest";
import { IpcError, toIpcError } from "./error";

test("a Rust error keeps its kind and message", () => {
  const error = toIpcError({ kind: "forbidden", message: "no list on pods" });
  expect(error).toBeInstanceOf(IpcError);
  expect([error.kind, error.message]).toEqual(["forbidden", "no list on pods"]);
});

test("a request the gate stopped keeps the mode and its source", () => {
  const blocked = {
    context: "prod-eu",
    mode: "read-only",
    source: { kind: "user" },
    class: "write",
    reason: "mode",
    verb: "create",
    target: "configmaps in a",
  } as const;
  const error = toIpcError({
    kind: "permissions",
    message: "prod-eu is read-only by your choice",
    blocked,
  });
  expect(error.kind).toBe("permissions");
  expect(error.blocked).toEqual(blocked);
  expect(
    toIpcError({ kind: "forbidden", message: "no" }).blocked,
  ).toBeUndefined();
});

test("anything else, such as Tauri's unknown-command string, is internal", () => {
  expect(toIpcError("Command spaces_list not found").kind).toBe("internal");
  expect(toIpcError(new Error("boom")).message).toBe("boom");
});
