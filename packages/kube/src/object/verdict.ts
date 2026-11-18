import type { Gvr } from "@twigo/protocol";
import type { Tone } from "@twigo/ui";
import { cellFinished, cellTone, statusColumn } from "../columns";

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
 */
export function verdictOf(
  gvr: Gvr,
  cell: (column: string) => string | undefined,
): Verdict | undefined {
  const column = statusColumn(gvr);
  const word = column === undefined ? undefined : cell(column);
  if (column === undefined || word === undefined || word === "")
    return undefined;
  return {
    word,
    tone: cellTone(gvr, column, word),
    finished: cellFinished(gvr, column, word),
  };
}
