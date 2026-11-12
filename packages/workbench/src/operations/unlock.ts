import type { Backend, Blocked } from "@twigo/protocol";
import { toIpcError } from "@twigo/protocol";
import type { ToastAction } from "@twigo/ui";

/**
 * Whether the person may lift what the gate refused with (ARCHITECTURE
 * 6.4): a read-only context unlocks for 15 minutes, unless a policy file set
 * it or no source lists the context.
 */
export function canUnlock(blocked: Blocked): boolean {
  return (
    blocked.reason === "mode" &&
    blocked.mode === "read-only" &&
    blocked.source.kind !== "policyFile" &&
    blocked.source.kind !== "unlisted"
  );
}

/** The button of a toast that says the mode refused a command, where the person may lift the lock. */
export function unlockAction(
  backend: Backend,
  error: unknown,
  report: (error: unknown) => void,
): ToastAction | undefined {
  const { blocked } = toIpcError(error);
  if (!blocked || !canUnlock(blocked)) return undefined;
  const { context } = blocked;
  return {
    label: "Unlock for 15 minutes",
    run: () => {
      backend.invoke("context_unlock", context).catch(report);
    },
  };
}
