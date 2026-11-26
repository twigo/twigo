import type { Row } from "@twigo/protocol";
import type { Tone } from "@twigo/ui";
import type { ShownColumn } from "./cells";

/**
 * Whether a row already raises its alarm in what is drawn: its own tone, from
 * its health column, or a ratio that draws a tone of its own, such as a pod's
 * short Ready. A signal of lower rank stays plain beside it. A finished
 * object's ratio is short of nothing, so it draws no tone.
 */
export function raisesAlarm(
  row: Row,
  columns: readonly ShownColumn[],
  rowTone: Tone | undefined,
  finished: boolean,
): boolean {
  const draws = (column: ShownColumn) => {
    const cell = row.cells[column.index];
    return (
      !finished &&
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
  readonly finished: boolean;
  readonly alarmed: boolean;
}

/**
 * A row's tone and alarm, decided once for its item and all its cells. It
 * remembers each row against the columns it was made for, and forgets it with
 * the row, so a grid makes one for its columns and keeps it while they stand.
 */
export function decideRows(
  toneOf: (row: Row) => Tone | undefined,
  finishedOf: (row: Row) => boolean,
  columns: readonly ShownColumn[],
): (row: Row) => RowDecision {
  const decided = new WeakMap<Row, RowDecision>();
  return (row) => {
    let decision = decided.get(row);
    if (!decision) {
      const tone = toneOf(row);
      const finished = finishedOf(row);
      decision = {
        tone,
        finished,
        alarmed: raisesAlarm(row, columns, tone, finished),
      };
      decided.set(row, decision);
    }
    return decision;
  };
}
