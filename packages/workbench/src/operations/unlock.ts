import type { Blocked } from "@twigo/protocol";
import { toIpcError } from "@twigo/protocol";
import type { ToastAction } from "@twigo/ui";
import type { Operations } from "./service";

/**
 * Whether the person may lift what the gate refused with (ARCHITECTURE
 * 6.4): a read-only context unlocks for 15 minutes, unless a policy file set
 * it, the person's protection file cannot be read or no source lists the
 * context; an unlock never reaches clients of a cluster the context no
 * longer names.
 */
export function canUnlock(blocked: Blocked): boolean {
  return (
    blocked.reason === "mode" &&
    blocked.mode === "read-only" &&
    blocked.source.kind !== "policyFile" &&
    blocked.source.kind !== "protectionUnreadable" &&
    blocked.source.kind !== "unlisted" &&
    blocked.source.kind !== "moved"
  );
}

/** The button of a toast that says the mode refused a command, where the person may lift the lock: it plans the unlock, which asks in a dialog. */
export function unlockAction(
  operations: Pick<Operations, "unlock">,
  error: unknown,
): ToastAction | undefined {
  const { blocked } = toIpcError(error);
  if (!blocked || !canUnlock(blocked)) return undefined;
  const { context } = blocked;
  return {
    label: "Unlock for 15 minutes",
    run: () => {
      void operations.unlock(context);
    },
  };
}
