const MIN_HEAD = 4;
const CUT_TAIL = 12;
/** The middle's track keeps this much, so a middle no wider than it leaves a gap in the name. */
const MIDDLE_TRACK = 2;

export interface Cut {
  readonly head: string;
  readonly middle: string;
  readonly tail: string;
}

/**
 * Where a text that gives way is cut: in the middle, so that its end stays,
 * and never under `floor` characters, head and tail together. A text of
 * `floor` characters or fewer is never cut, nor one whose middle measures 2em
 * or less by `emWidth`: the whole text is then no wider than its head, the 2em
 * that the middle's track keeps and its tail, so it takes no more than the
 * cut's floor, and the track would leave a gap where the middle falls short.
 * The tail is the part after the last `separator` when it fits the floor and
 * leaves the head `MIN_HEAD` characters, else the last characters, so that a
 * cluster's ARN keeps its name and a list of namespaces its last one.
 */
export function cutText(
  text: string,
  floor: number,
  separator: string | RegExp,
  emWidth: (text: string) => number,
): Cut | undefined {
  if (text.length <= floor) return undefined;
  const parts = text.split(separator);
  const last = parts[parts.length - 1] ?? "";
  const tail =
    last.length > 0 && last.length <= floor - MIN_HEAD
      ? last
      : text.slice(-CUT_TAIL);
  const head = text.slice(0, floor - tail.length);
  const middle = text.slice(head.length, text.length - tail.length);
  if (emWidth(middle) <= MIDDLE_TRACK) return undefined;
  return { head, middle, tail };
}
