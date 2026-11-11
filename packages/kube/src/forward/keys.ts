import type { Forward } from "@twigo/protocol";
import type { Lookup } from "@twigo/workbench";
import { webOf } from "./words";

/** What a forward's commands read: that there is one, and what its state lets be done to it. */
export function forwardKeys(
  forward: Forward,
): Readonly<Record<string, boolean>> {
  const { state } = forward.state;
  return {
    forward: true,
    "forward.running": state !== "stopped",
    "forward.startable": state === "stopped" || state === "failed",
    "forward.web": webOf(forward) !== undefined,
  };
}

/** `lookup`, answering the forward's keys as well. */
export function withForward(lookup: Lookup, forward: Forward): Lookup {
  const keys = forwardKeys(forward);
  return (key) => keys[key] ?? lookup(key);
}
