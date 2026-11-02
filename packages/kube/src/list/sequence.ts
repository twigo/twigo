import type { RowGroup } from "@twigo/protocol";

/** An item of the grid: a group's header, or a row of the rows Rust windows. */
export type Slot =
  | { readonly type: "group"; readonly group: RowGroup; readonly open: boolean }
  | { readonly type: "row"; readonly row: number };

/**
 * The grid's items over the rows Rust sends (ARCHITECTURE 3.4): without
 * groups each item is a row; with them each group's header comes before
 * its rows, and a collapsed group's rows, which Rust leaves out of its
 * sequence, take no items.
 */
export interface Sequence {
  readonly length: number;
  at(index: number): Slot | undefined;
  /** The item that shows row `row` of Rust's sequence. */
  itemOf(row: number): number;
  /** The header item of the group of `value`, or -1. */
  headerOf(value: string): number;
  /** Rust's rows behind items `start` to `end`, both exclusive at the end. */
  rows(start: number, end: number): readonly [number, number];
}

export function sequence(
  groups: readonly RowGroup[] | undefined,
  collapsed: ReadonlySet<string>,
  total: number,
): Sequence {
  if (!groups) {
    return {
      length: total,
      at: (index) =>
        index >= 0 && index < total ? { type: "row", row: index } : undefined,
      itemOf: (row) => row,
      headerOf: () => -1,
      rows: (start, end) => [start, end],
    };
  }
  /** Per group: its header's item, its first row in Rust's sequence, whether open. */
  const marks: { header: number; first: number; open: boolean }[] = [];
  let items = 0;
  let rows = 0;
  for (const group of groups) {
    const open = !collapsed.has(group.value);
    marks.push({ header: items, first: rows, open });
    items += 1 + (open ? group.rows : 0);
    if (open) rows += group.rows;
  }
  const opened = marks.filter((mark) => mark.open);

  /** Where in `list` the last entry whose `key` is at or before `value` is. */
  const lastAt = <T>(
    list: readonly T[],
    key: (t: T) => number,
    value: number,
  ): number => {
    let low = 0;
    let high = list.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      const at = list[middle];
      if (at !== undefined && key(at) <= value) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  /** Rows of Rust's sequence before item `index`. */
  const rowsBefore = (index: number): number => {
    if (index >= items) return rows;
    const mark = marks[lastAt(marks, (m) => m.header, index)];
    if (!mark) return 0;
    const offset = index - mark.header;
    return offset === 0 ? mark.first : mark.first + offset - 1;
  };

  return {
    length: items,
    at(index) {
      if (index < 0 || index >= items) return undefined;
      const position = lastAt(marks, (m) => m.header, index);
      const mark = marks[position];
      const group = groups[position];
      if (!mark || !group) return undefined;
      const offset = index - mark.header;
      return offset === 0
        ? { type: "group", group, open: mark.open }
        : { type: "row", row: mark.first + offset - 1 };
    },
    itemOf(row) {
      const mark = opened[lastAt(opened, (m) => m.first, row)];
      return mark ? mark.header + 1 + row - mark.first : row;
    },
    headerOf(value) {
      const position = groups.findIndex((group) => group.value === value);
      return marks[position]?.header ?? -1;
    },
    rows(start, end) {
      const from = rowsBefore(Math.max(0, start));
      return [from, Math.max(from, rowsBefore(Math.max(0, end)))];
    },
  };
}
