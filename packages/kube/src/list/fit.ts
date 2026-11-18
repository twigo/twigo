import type { Sort } from "@twigo/protocol";
import type { ColumnRule } from "../columns";

/** A column that may leave a list too narrow for it. */
export interface Leaver {
  readonly name: string;
  /** What it takes while it shows: the user's width, else its rule's. */
  readonly width: number;
  /** `ColumnRule.drop`. */
  readonly drop: number;
  /** `ColumnRule.into`. */
  readonly into?: { readonly column: string; readonly room: number };
}

/**
 * The columns that leave a list `room` px wide, so that the rest fit beside
 * `fixed`, the width of what never leaves: one at a time in their drop
 * order, the right-hand one first among equals. A column that goes into one
 * that stays leaves that one the room for its value. The same columns and
 * room give the same answer, and a wider room only brings columns back, last
 * gone first, so what the list shows is a function of its width and never
 * of the way it got there.
 */
export function leaving(
  fixed: number,
  columns: readonly Leaver[],
  room: number,
): ReadonlySet<string> {
  const order = columns
    .map((column, at) => ({ column, at }))
    .sort((a, b) => a.column.drop - b.column.drop || b.at - a.at);
  const names = new Set(columns.map(({ name }) => name));
  const gone = new Set<string>();
  const taken = () =>
    columns.reduce((sum, { name, width, into }) => {
      if (!gone.has(name)) return sum + width;
      const joins = into && names.has(into.column) && !gone.has(into.column);
      return joins ? sum + into.room : sum;
    }, fixed);
  for (const { column } of order) {
    if (taken() <= room) break;
    gone.add(column.name);
  }
  return gone;
}

interface Candidate {
  readonly name: string;
  readonly rule: ColumnRule;
}

/**
 * The columns a list shows in `room` px, in their order, each with the one
 * that left into it, and the names of those that left. The name column never
 * leaves; the rest go by `leaving`.
 */
export function fitColumns<C extends Candidate>(
  chosen: readonly C[],
  widthOf: (column: C) => number,
  room: number,
): {
  columns: readonly (C & { readonly merged?: C })[];
  gone: ReadonlySet<string>;
} {
  const gone = leaving(
    chosen
      .filter((column) => column.name === "Name")
      .reduce((sum, column) => sum + widthOf(column), 0),
    chosen
      .filter((column) => column.name !== "Name")
      .map((column) => ({
        name: column.name,
        width: widthOf(column),
        drop: column.rule.drop,
        ...(column.rule.into && { into: column.rule.into }),
      })),
    room,
  );
  const columns = chosen
    .filter((column) => !gone.has(column.name))
    .map((column) => {
      const merged = chosen.find(
        (other) =>
          gone.has(other.name) && other.rule.into?.column === column.name,
      );
      return merged ? { ...column, merged } : column;
    });
  return { columns, gone };
}

/** What a list says when it is sorted by a column that has no room at its width. */
export function lostSort(
  sort: Sort | null | undefined,
  gone: ReadonlySet<string>,
): string | undefined {
  return sort && gone.has(sort.column)
    ? `Sorted by ${sort.column}, ${sort.descending ? "descending" : "ascending"}: the column has no room at this width.`
    : undefined;
}
