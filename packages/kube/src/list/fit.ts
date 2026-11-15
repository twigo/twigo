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
