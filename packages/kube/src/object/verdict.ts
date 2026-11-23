import type { Gvr, Overview } from "@twigo/protocol";
import type { Tone } from "@twigo/ui";
import { cellFinished, cellTone, statusColumn } from "../columns";
import { TONE } from "./tone";

/** The word of an object's health column and how the list tones it. */
export interface Verdict {
  readonly word: string;
  /** Undefined for a healthy word. */
  readonly tone: Tone | undefined;
  /** The object ran to completion, so nothing in it is news any more. */
  readonly finished: boolean;
}

/**
 * What the list's own rule makes of an object's health column, from the cell
 * the server printed for it, wherever that cell was read: the row, or the
 * header the object's Overview carries. A kind with no health column has none.
 * A word the rule calls healthy takes the tone of the core's findings, which
 * know what a column cannot: a Deployment that is `4/4` and past its deadline.
 */
export function verdictOf(
  gvr: Gvr,
  cell: (column: string) => string | undefined,
  found?: Tone,
): Verdict | undefined {
  const column = statusColumn(gvr);
  const word = column === undefined ? undefined : cell(column);
  if (column === undefined || word === undefined || word === "")
    return undefined;
  return {
    word,
    tone: cellTone(gvr, column, word) ?? found,
    finished: cellFinished(gvr, column, word),
  };
}

/** The tone of the core's findings of an object, or a release, which its Diagnostics section carries. */
export function foundTone(
  overview: Overview | undefined,
  section = "core.diagnostics",
): Tone | undefined {
  const tone = overview?.sections.find(({ id }) => id === section)?.tone;
  return tone ? TONE[tone] : undefined;
}
