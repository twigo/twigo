import type { LineItem } from "./LineList";

/**
 * A line's time split where it moves from the line above: `12:04:` and
 * `05.123` of `12:04:05.123` after `12:04:04.987`, from the first field
 * that differs. A first line, or one after a marker, which shows no time,
 * is all changed.
 */
export function timeAfter(
  time: string,
  above: LineItem | undefined,
): { readonly same: string; readonly changed: string } {
  if (above?.kind !== "line") return { same: "", changed: time };
  if (time === above.time) return { same: time, changed: "" };
  let same = 0;
  for (let at = 0; time[at] === above.time[at]; at++) {
    if (time[at] === ":" || time[at] === ".") same = at + 1;
  }
  return { same: time.slice(0, same), changed: time.slice(same) };
}

/** Whether a message goes on the one above it, as a stack trace's lines do: it starts with whitespace. */
export function continues(text: string): boolean {
  return /^\s/.test(text);
}
