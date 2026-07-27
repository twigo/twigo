import type { ConnInfo } from "@/lib/api";

export type LinkState =
  "dialling" | "live" | "reconnecting" | "failed" | "offline";

/**
 * One name per thing the glyph can show. Booleans could not express it: "has an
 * entry" and "that entry has a live link" are different questions, and naming
 * them both some variant of "connected" is how they got confused.
 */
export function linkState(
  info: ConnInfo | undefined,
  connecting: boolean,
  error: boolean,
): LinkState {
  if (connecting) return "dialling";
  if (info?.server) return "live";
  if (info) return "reconnecting";
  return error ? "failed" : "offline";
}
