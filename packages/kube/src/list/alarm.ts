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
