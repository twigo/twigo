import { wire } from "./error";
import type { IpcError as Wire, ViewState } from "./generated";

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

type Refused = Extract<
  ViewState,
  { state: "forbidden" | "unauthorized" | "error" }
>;

/**
 * What the cluster's refusal says as an error, in the words of Rust's
 * `ViewState::refusal`: none for a state that is not one.
 */
export function refusal(state: Refused): Wire;
export function refusal(state: ViewState): Wire | undefined;
export function refusal(state: ViewState): Wire | undefined {
  switch (state.state) {
    case "forbidden":
      return wire(
        "server.forbidden",
        `You may not ${state.verb} ${state.resource}.`,
      );
    case "unauthorized":
      return wire(
        "server.unauthorized",
        "The cluster does not accept the credentials.",
      );
    case "error":
      return state.error;
    default:
      return undefined;
  }
}
