/**
 * The text the API server prints in a cell, as Rust's `printed` module reads
 * it: a count, and a duration as Kubernetes prints one (`2y10d`, `5h3m`,
 * `45s`), alone or in a pod's `3 (5m ago)`.
 */

export function count(text: string): number | null {
  return /^[0-9]+$/.test(text) ? Number(text) : null;
}

const UNITS: readonly (readonly [string, number])[] = [
  ["y", 365 * 86_400],
  ["d", 86_400],
  ["h", 3_600],
  ["m", 60],
  ["s", 1],
];

/** A duration as Kubernetes prints one, each unit at most once, largest first. */
function duration(text: string): number | null {
  if (text === "") return null;
  let seconds = 0;
  let unit = 0;
  let at = 0;
  while (at < text.length) {
    let end = at;
    while (end < text.length && /[0-9]/.test(text.charAt(end))) end++;
    if (end === at || end === text.length) return null;
    const name = text.charAt(end);
    while (unit < UNITS.length && UNITS[unit]?.[0] !== name) unit++;
    const found = UNITS[unit];
    if (!found) return null;
    seconds += Number(text.slice(at, end)) * found[1];
    unit++;
    at = end + 1;
  }
  return seconds;
}

/** A duration the server printed: `5m`, or a pod's `3 (5m ago)` with the count of restarts. */
export interface Printed {
  readonly count: string | null;
  /** In seconds. */
  readonly ago: number;
}

export function parsePrinted(text: string): Printed | null {
  const ago = duration(text);
  if (ago !== null) return { count: null, ago };
  if (!text.endsWith(" ago)")) return null;
  const rest = text.slice(0, -" ago)".length);
  const at = rest.indexOf(" (");
  if (at < 0) return null;
  const counted = rest.slice(0, at);
  const since = duration(rest.slice(at + 2));
  return count(counted) === null || since === null
    ? null
    : { count: counted, ago: since };
}

/** How much longer than its step one moment may print the same age, as Rust's `TOLERANCE_MS`. */
const TOLERANCE_MS = 2000;

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;

/** The step `HumanDuration` prints an age of `ago` seconds in, in seconds. */
function step(ago: number): number {
  if (ago < 10 * MINUTE) return 1;
  if (ago < 8 * HOUR) return MINUTE;
  if (ago < 8 * DAY) return HOUR;
  if (ago < 8 * YEAR) return DAY;
  return YEAR;
}

/**
 * Whether `heldAt`, when `held` was printed, still dates `printed`, printed
 * at `at`, as Rust's `printed::keeps_stamp` decides: the same age, less than
 * its step gone, give or take the tolerance. Times are Unix milliseconds.
 */
export function keepsStamp(
  held: string | null,
  heldAt: number,
  printed: string | null,
  at: number,
): boolean {
  const now = printed === null ? null : parsePrinted(printed);
  if (now === null) return true;
  const then = held === null ? null : parsePrinted(held);
  if (then === null) return false;
  const passed = at - heldAt;
  return (
    then.ago === now.ago &&
    -TOLERANCE_MS <= passed &&
    passed < step(now.ago) * 1000 + TOLERANCE_MS
  );
}
