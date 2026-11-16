import { parseDuration } from "@twigo/utils";

const FRESH_MS = 10 * 60 * 1000;
const RESTART_RECENT_MS = 60 * 60 * 1000;
/** The core stamps a row with the clock of the machine the webview runs on. */
const AHEAD_MS = 1000;

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
 * text that is no duration, as `<unknown>`, and for a `received` that is no
 * time.
 */
export function printedAt(
  received: string,
  printed: string,
): number | undefined {
  const age = parseDuration(printed);
  const sent = Date.parse(received);
  return age === undefined || Number.isNaN(sent) ? undefined : sent - age;
}

/**
 * How long ago a moment from `printedAt` was, or none when there is no usable
 * one: a moment more than a second ahead of the clock was printed in no
 * past. A cell without it shows what the server printed.
 */
export function printedAge(
  at: number | undefined,
  now: number,
): number | undefined {
  return at === undefined || at - now > AHEAD_MS ? undefined : now - at;
}

export function restartedRecently(ms: number): boolean {
  return ms < RESTART_RECENT_MS;
}
