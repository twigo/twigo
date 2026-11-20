import type { ViewState } from "./generated";

export const SHOWS_ROWS: ReadonlySet<ViewState["state"]> = new Set([
  "ready",
  "relisting",
  "stale",
]);

/** The states of a part or a view that stays down until the person or the server acts. */
export const REFUSED: ReadonlySet<ViewState["state"]> = new Set([
  "forbidden",
  "unauthorized",
  "error",
]);

const READINESS: readonly ViewState["state"][] = [
  "ready",
  "stale",
  "relisting",
  "syncing",
  "connecting",
  "queued",
  "forbidden",
  "unauthorized",
  "error",
];

/** How far a state is from ready: 0 for ready, more for each that is worse. */
export function readiness(state: ViewState): number {
  return READINESS.indexOf(state.state);
}

/** The least ready of some states, as Rust's `combine` has it: syncing ones add up. */
export function leastReady(states: Iterable<ViewState>): ViewState {
  let worst: ViewState = { state: "ready" };
  let loaded = 0;
  for (const state of states) {
    if (state.state === "syncing") loaded += state.loaded;
    if (readiness(state) > readiness(worst)) worst = state;
  }
  return worst.state === "syncing" ? { state: "syncing", loaded } : worst;
}
