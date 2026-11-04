/** A line's height in px, which a line of a wheel's delta and a page's overlap count in. */
export const ROW = 19;

/** Where a key sends the list: a page up or down, or an edge. */
export type Move = "up" | "down" | "first" | "last";

/**
 * The list's own keys, which it moves itself for, at once, on every
 * platform, besides ↑, ↓, Home and End, which the list commands send it:
 * the engines scroll on some of them natively, and WebKit animates a key's
 * scroll and stops it at the list's next write of `scrollTop`.
 */
const MOVES = new Map<string, Move>([
  ["PageUp", "up"],
  ["PageDown", "down"],
  ["Space", "down"],
  ["Shift+Space", "up"],
  ["Alt+ArrowUp", "up"],
  ["Alt+ArrowDown", "down"],
  ["Control+ArrowUp", "up"],
  ["Control+ArrowDown", "down"],
  ["Control+Alt+ArrowUp", "up"],
  ["Control+Alt+ArrowDown", "down"],
  ["Meta+ArrowUp", "first"],
  ["Meta+ArrowDown", "last"],
  ["Control+Home", "first"],
  ["Control+End", "last"],
]);

type Chord = Pick<
  KeyboardEvent,
  "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey"
>;

export function moveOf({
  key,
  altKey,
  ctrlKey,
  metaKey,
  shiftKey,
}: Chord): Move | undefined {
  return MOVES.get(
    [
      shiftKey ? "Shift+" : "",
      ctrlKey ? "Control+" : "",
      altKey ? "Alt+" : "",
      metaKey ? "Meta+" : "",
      key === " " ? "Space" : key,
    ].join(""),
  );
}

/** What a page keeps in view of the one before, about what the browsers keep. */
const OVERLAP = 2 * ROW;

/**
 * A page of a list `length` px long: its length less two rows, or in a
 * short list Chromium's share of it, more than WebKit's 4/5, so a page is
 * never less than a browser's, and at least a pixel, as the browsers' are.
 */
export function pageOf(length: number): number {
  return Math.max(1, length - OVERLAP, Math.floor((length * 7) / 8));
}

/** The px of one unit of a wheel's delta along a list `length` px long. */
function unitOf(mode: number, length: number): number {
  if (mode === WheelEvent.DOM_DELTA_LINE) return ROW;
  if (mode === WheelEvent.DOM_DELTA_PAGE) return pageOf(length);
  return 1;
}

/**
 * How far a wheel scrolls a list `width` by `height` px, in px, sideways
 * and along it, with ⌃ or ⇧ as `LineList`'s `mac` says; undefined for a
 * wheel that is the engine's.
 */
export function wheelDeltas(
  {
    deltaX,
    deltaY,
    deltaMode,
    ctrlKey,
    shiftKey,
  }: Pick<
    WheelEvent,
    "deltaX" | "deltaY" | "deltaMode" | "ctrlKey" | "shiftKey"
  >,
  mac: boolean,
  width: number,
  height: number,
): { dx: number; dy: number } | undefined {
  if (ctrlKey && !mac) return undefined;
  const across = unitOf(deltaMode, width);
  if (!mac && shiftKey && deltaX === 0) return { dx: deltaY * across, dy: 0 };
  return { dx: deltaX * across, dy: deltaY * unitOf(deltaMode, height) };
}
