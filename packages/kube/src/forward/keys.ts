import type { Forward } from "@twigo/protocol";
import { canUnlock, type Lookup } from "@twigo/workbench";
import { listensOn, webOf } from "./words";

/**
 * What a forward's commands read: that there is one, and what its state lets
 * be done to it. A forward that failed on a lock the person cannot lift may
 * neither start nor move until the lock goes.
 */
export function forwardKeys(
  forward: Forward,
): Readonly<Record<string, boolean>> {
  const { state } = forward;
  const locked =
    state.state === "failed" &&
    state.error.blocked !== undefined &&
    !canUnlock(state.error.blocked);
  const listens = listensOn(forward).length > 0;
  return {
    forward: true,
    "forward.running": state.state !== "stopped",
    "forward.startable":
      !locked &&
      (state.state === "stopped" ||
        state.state === "failed" ||
        state.state === "reconnecting"),
    "forward.movable": !locked,
    "forward.web":
      webOf(forward) !== undefined && listens && state.state !== "failed",
  };
}

/** `lookup`, answering the forward's keys as well. */
export function withForward(lookup: Lookup, forward: Forward): Lookup {
  const keys = forwardKeys(forward);
  return (key) => keys[key] ?? lookup(key);
}
