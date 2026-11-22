import { expect, test } from "vitest";
import { IpcError, toIpcError } from "./error";

test("a Rust error keeps its code, its kind and its message", () => {
  const error = toIpcError({
    code: "server.forbidden",
    kind: "forbidden",
    message: "no list on pods",
  });
  expect(error).toBeInstanceOf(IpcError);
  expect([error.code, error.kind, error.message]).toEqual([
    "server.forbidden",
    "forbidden",
    "no list on pods",
  ]);
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
    code: "policy.blocked",
    kind: "permissions",
    message: "prod-eu is read-only by your choice",
    blocked,
  });
  expect(error.kind).toBe("permissions");
  expect(error.blocked).toEqual(blocked);
  expect(
    toIpcError({ code: "server.forbidden", kind: "forbidden", message: "no" })
      .blocked,
  ).toBeUndefined();
});

test("the API server's status travels beside the code", () => {
  const server = {
    reason: "Invalid",
    causes: [
      {
        reason: "FieldValueInvalid",
        field: "spec.replicas",
        message: "must be non-negative",
      },
    ],
  };
  const error = toIpcError({
    code: "server.invalid",
    kind: "invalidInput",
    message: "invalid",
    server,
  });
  expect(error.server).toEqual(server);
});

test("the kind comes from the table Rust writes, whatever the error says", () => {
  expect(new IpcError("connect.timeout", "late").kind).toBe("timeout");
  expect(new IpcError("policy.blocked", "no").kind).toBe("permissions");
});

test("anything else, such as Tauri's unknown-command string or an unknown code, is internal.ipc", () => {
  expect(toIpcError("Command spaces_list not found").code).toBe("internal.ipc");
  expect(toIpcError(new Error("boom")).message).toBe("boom");
  const unknown = toIpcError({ code: "made.up", message: "no" });
  expect([unknown.code, unknown.kind, unknown.message]).toEqual([
    "internal.ipc",
    "internal",
    "no",
  ]);
});
