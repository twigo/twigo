import { single } from "fuzzysort";

/** Characters `start` up to `end` of a text, in UTF-16 code units. */
export interface TextRange {
  readonly start: number;
  readonly end: number;
}

export interface TextMatch {
  /** 1 for the text itself, down towards 0. */
  readonly score: number;
  /** The matched characters as runs, in order. */
  readonly ranges: readonly TextRange[];
}

/**
 * How a text matches what was typed, as Sublime Text matches: the typed
 * characters in order, each word of the search on its own. Undefined for no
 * match or an empty search.
 */
export function fuzzyMatch(
  text: string,
  search: string,
): TextMatch | undefined {
  const result = single(search, text);
  if (!result) return undefined;
  const ranges: TextRange[] = [];
  for (const index of result.indexes) {
    const last = ranges[ranges.length - 1];
    if (last?.end === index)
      ranges[ranges.length - 1] = { ...last, end: index + 1 };
    else ranges.push({ start: index, end: index + 1 });
  }
  return { score: result.score, ranges };
}
