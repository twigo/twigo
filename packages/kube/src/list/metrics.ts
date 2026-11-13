import type { MetricsState, Row, Sort } from "@twigo/protocol";
import type { ShownColumn } from "./cells";

/**
 * Whether a list reads its metric columns (ARCHITECTURE 3.6): one is drawn
 * or the list is sorted by one, the document is visible, and the list is
 * not the narrow one beside the details, which draws none of them.
 */
export function readsMetrics({
  columns,
  shown,
  sort,
  visible,
  narrow,
}: {
  /** Every column of the list. */
  columns: readonly ShownColumn[];
  /** The columns drawn. */
  shown: readonly ShownColumn[];
  sort: Sort | null;
  visible: boolean;
  narrow: boolean;
}): boolean {
  if (!visible || narrow) return false;
  return (
    shown.some((column) => column.rule.metric) ||
    columns.some((column) => column.rule.metric && column.name === sort?.column)
  );
}

/** What is said where a Metrics API gives no values. */
export const METRICS_NOTES: Readonly<
  Record<Exclude<MetricsState, "ready">, string>
> = {
  unavailable: "metrics-server does not answer, so there is no CPU or memory.",
  forbidden: "You may not read metrics here, so there is no CPU or memory.",
};

/** What a metric column's header says while the Metrics API gives no values. */
export function metricsNote(
  state: MetricsState | null,
  column: ShownColumn,
): string | undefined {
  return state !== null && state !== "ready" && column.rule.metric
    ? METRICS_NOTES[state]
    : undefined;
}

/**
 * Whether a row is the one it was but for its measures, which a poll
 * changes and nothing selected reads, so a poll leaves a selection alone.
 */
export function sameBesidesMetrics(
  row: Row,
  before: Row | undefined,
  columns: readonly ShownColumn[],
): boolean {
  if (row === before) return true;
  if (before === undefined) return false;
  const measures = new Set(
    columns.filter((column) => column.rule.metric).map(({ index }) => index),
  );
  return (
    row.id === before.id &&
    row.created === before.created &&
    row.generated === before.generated &&
    row.cells.length === before.cells.length &&
    row.cells.every((cell, at) => measures.has(at) || cell === before.cells[at])
  );
}
