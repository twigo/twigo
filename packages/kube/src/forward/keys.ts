import type { Blocked, Forward } from "@twigo/protocol";
import { canUnlock, type Lookup } from "@twigo/workbench";
import { listensOn, webOf } from "./words";

/**
 * Whether a start may get past what a forward failed on: the clients it
 * builds reach the cluster the context names now and meet that one's mode,
 * and an unlock lifts any lock it reaches.
 */
function startMayPass(blocked: Blocked): boolean {
  return blocked.source.kind === "moved" || canUnlock(blocked);
}

/**
 * What a forward's commands read: that there is one, and what its state lets
 * be done to it. A forward that failed on a lock no start may get past may
 * neither start nor move until the lock goes.
 */
export function forwardKeys(
  forward: Forward,
): Readonly<Record<string, boolean>> {
  const { state } = forward;
  const locked =
    state.state === "failed" &&
    state.error.blocked !== undefined &&
    !startMayPass(state.error.blocked);
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
