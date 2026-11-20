import { expect, test, vi } from "vitest";
import { IpcError, type Blocked, type ModeSource } from "@twigo/protocol";
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

function operationsOf(unlock: (context: string) => Promise<never>) {
  return { unlock };
}

test.each<ModeSource>([
  { kind: "environment", environment: "production" },
  { kind: "user", overrides: null },
  { kind: "kubeconfig" },
  { kind: "provider" },
])(
  "a lock set by %o may be lifted, and the button plans the unlock of that context",
  (source) => {
    const unlock = vi.fn(() => new Promise<never>(() => undefined));
    const action = unlockAction(operationsOf(unlock), refusal(source));
    expect(action?.label).toBe("Unlock for 15 minutes");
    expect(unlock).not.toHaveBeenCalled();
    action?.run();
    expect(unlock).toHaveBeenCalledWith("prod-eu");
  },
);

test.each<ModeSource>([
  { kind: "policyFile", file: "/etc/twigo/policy.json", pattern: "prod-*" },
  { kind: "unlisted" },
])("a lock set by %o offers nothing", (source) => {
  expect(unlockAction(operationsOf(vi.fn()), refusal(source))).toBe(undefined);
});

test("a refusal that is not the mode of a read-only context, and any other error, offers nothing", () => {
  const source: ModeSource = { kind: "user", overrides: null };
  const none = (error: unknown) => unlockAction(operationsOf(vi.fn()), error);
  expect(none(refusal(source, { mode: "guarded" }))).toBeUndefined();
  expect(none(refusal(source, { reason: "noApproval" }))).toBeUndefined();
  expect(none(refusal(source, { reason: "noGrant" }))).toBeUndefined();
  expect(none(refusal(source, { reason: "unmarked" }))).toBeUndefined();
  expect(none(new IpcError("notFound", "no forward 41"))).toBeUndefined();
  expect(none(new Error("boom"))).toBeUndefined();
});

test.each<[ModeSource, boolean]>([
  [{ kind: "user", overrides: null }, true],
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
