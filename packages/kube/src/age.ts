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
 * The moment a duration the server printed stands for: it printed it when it
 * sent the row, which `received` says, so it counts back from there. None for
 * text that is no duration, as `<unknown>`.
 */
export function printedAt(
  received: string,
  printed: string,
): number | undefined {
  const age = parseDuration(printed);
  return age === undefined ? undefined : Date.parse(received) - age;
}

export function restartedRecently(ms: number): boolean {
  return ms < RESTART_RECENT_MS;
}
