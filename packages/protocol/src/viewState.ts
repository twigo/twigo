import type { ViewState } from "./generated";

/** The states in which a list shows rows. */
export const SHOWS_ROWS: ReadonlySet<ViewState["state"]> = new Set([
  "ready",
  "relisting",
  "stale",
]);
