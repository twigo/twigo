import { expect, test, vi } from "vitest";
import {
  IpcError,
  type Backend,
  type Blocked,
  type ModeSource,
} from "@twigo/protocol";
import { canUnlock, unlockAction } from "./unlock";

function refusal(source: ModeSource, more: Partial<Blocked> = {}): IpcError {
  const blocked: Blocked = {
    context: "prod-eu",
    mode: "read-only",
    source,
    class: "forward",
    reason: "mode",
    verb: "get",
    target: "pods/portforward in payments",
    ...more,
  };
  return new IpcError("permissions", "prod-eu is read-only", blocked);
}

function backendOf(invoke: () => Promise<null>): Backend {
  return { invoke, subscribe: () => Promise.reject(new Error("no")) } as never;
}

test.each<ModeSource>([
  { kind: "environment", environment: "production" },
  { kind: "user" },
  { kind: "kubeconfig" },
  { kind: "provider" },
  { kind: "default" },
])(
  "a lock set by %o may be lifted, and the button unlocks that context",
  (source) => {
    const invoke = vi.fn(() => Promise.resolve(null));
    const action = unlockAction(backendOf(invoke), refusal(source), vi.fn());
    expect(action?.label).toBe("Unlock for 15 minutes");
    expect(invoke).not.toHaveBeenCalled();
    action?.run();
    expect(invoke).toHaveBeenCalledWith("context_unlock", "prod-eu");
  },
);

test.each<ModeSource>([
  { kind: "policyFile", file: "/etc/twigo/policy.json", pattern: "prod-*" },
  { kind: "unlisted" },
])("a lock set by %o offers nothing", (source) => {
  expect(unlockAction(backendOf(vi.fn()), refusal(source), vi.fn())).toBe(
    undefined,
  );
});

test("a refusal that is not the mode of a read-only context, and any other error, offers nothing", () => {
  const source: ModeSource = { kind: "user" };
  const none = (error: unknown) =>
    unlockAction(backendOf(vi.fn()), error, vi.fn());
  expect(none(refusal(source, { mode: "guarded" }))).toBeUndefined();
  expect(none(refusal(source, { reason: "noApproval" }))).toBeUndefined();
  expect(none(refusal(source, { reason: "noGrant" }))).toBeUndefined();
  expect(none(new IpcError("notFound", "no forward 41"))).toBeUndefined();
  expect(none(new Error("boom"))).toBeUndefined();
});

test.each<[ModeSource, boolean]>([
  [{ kind: "user" }, true],
  [{ kind: "kubeconfig" }, true],
  [
    { kind: "policyFile", file: "/etc/twigo/policy.json", pattern: null },
    false,
  ],
  [{ kind: "unlisted" }, false],
])("a lock set by %o may be lifted: %s", (source, lifted) => {
  const { blocked } = refusal(source);
  if (!blocked) throw new Error("no refusal");
  expect(canUnlock(blocked)).toBe(lifted);
  expect(canUnlock({ ...blocked, mode: "guarded" })).toBe(false);
  expect(canUnlock({ ...blocked, reason: "noGrant" })).toBe(false);
});

test("an unlock that fails is reported", async () => {
  const failed = new IpcError("internal", "nothing to unlock");
  const report = vi.fn();
  unlockAction(
    backendOf(() => Promise.reject(failed)),
    refusal({ kind: "user" }),
    report,
  )?.run();
  await vi.waitFor(() => {
    expect(report).toHaveBeenCalledWith(failed);
  });
});
