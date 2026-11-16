import { parseDuration } from "@twigo/utils";

const FRESH_MS = 10 * 60 * 1000;
const RESTART_RECENT_MS = 60 * 60 * 1000;

/**
 * The role of an age in text: one under ten minutes is worth reading now,
 * an older one only places the object.
 */
export function ageRole(ms: number): "text-content" | "text-support" {
  return ms < FRESH_MS ? "text-content" : "text-support";
}

/**
 * Whether the "… ago" of a Restarts cell, as kubectl prints it, says the
 * last restart was within the hour; an unknown or unreadable one did not.
 */
export function restartedRecently(ago: string | undefined): boolean {
  const ms = ago === undefined ? undefined : parseDuration(ago);
  return ms !== undefined && ms < RESTART_RECENT_MS;
}
