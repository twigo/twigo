const MIN_HEAD = 4;
const CUT_TAIL = 12;

export interface Cut {
  readonly head: string;
  readonly middle: string;
  readonly tail: string;
}

/**
 * Where a text that gives way is cut: in the middle, so that its end stays,
 * and never under `floor` characters, head and tail together. A text of
 * `floor` characters or fewer is never cut. The tail is the part after the
 * last `separator` when it fits the floor and leaves the head `MIN_HEAD`
 * characters, else the last characters, so that a cluster's ARN keeps its name
 * and a list of namespaces its last one.
 */
export function cutText(
  text: string,
  floor: number,
  separator: string | RegExp,
): Cut | undefined {
  if (text.length <= floor) return undefined;
  const parts = text.split(separator);
  const last = parts[parts.length - 1] ?? "";
  const tail =
    last.length > 0 && last.length <= floor - MIN_HEAD
      ? last
      : text.slice(-CUT_TAIL);
  const head = text.slice(0, floor - tail.length);
  return {
    head,
    middle: text.slice(head.length, text.length - tail.length),
    tail,
  };
}
