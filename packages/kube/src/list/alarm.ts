import type { Row } from "@twigo/protocol";
import type { Tone } from "@twigo/ui";
import type { ShownColumn } from "./cells";

/**
 * Whether a row already raises its alarm in what is drawn: its own tone, from
 * its health column, or a ratio that draws a tone of its own, such as a pod's
 * short Ready. A signal of lower rank stays plain beside it.
 */
export function raisesAlarm(
  row: Row,
  columns: readonly ShownColumn[],
  rowTone: Tone | undefined,
): boolean {
  const draws = (column: ShownColumn) => {
    const cell = row.cells[column.index];
    return (
      column.rule.cell === "ratio" &&
      typeof cell === "string" &&
      column.rule.tone?.(cell) !== undefined
    );
  };
  return (
    rowTone !== undefined ||
    columns.some(
      (column) =>
        draws(column) || (column.merged !== undefined && draws(column.merged)),
    )
  );
}

interface RowDecision {
  readonly tone: Tone | undefined;
  readonly alarmed: boolean;
}

/**
 * A row's tone and alarm, decided once for its item and all its cells. It
 * remembers rows against the columns of the render that made it, so a grid
 * makes one in its body and keeps none beyond it.
 */
export function decideRows(
  toneOf: (row: Row) => Tone | undefined,
  columns: readonly ShownColumn[],
): (row: Row) => RowDecision {
  const decided = new Map<Row, RowDecision>();
  return (row) => {
    let decision = decided.get(row);
    if (!decision) {
      const tone = toneOf(row);
      decision = { tone, alarmed: raisesAlarm(row, columns, tone) };
      decided.set(row, decision);
    }
    return decision;
  };
}
