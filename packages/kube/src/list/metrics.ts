import type { Cell, Row, ServedMetrics, Sort } from "@twigo/protocol";
import { formatCpu, formatMemory } from "@twigo/utils";
import type { ShownColumn } from "./cells";

export function measureText(
  kind: "cpu" | "memory",
  cell: Cell,
): string | undefined {
  if (typeof cell !== "number") return undefined;
  return (kind === "cpu" ? formatCpu : formatMemory)(cell);
}

/**
 * Whether a list reads its metric columns (ARCHITECTURE 3.6): the document
 * is visible, its editor on screen, and the list is not the narrow one
 * beside the details, which draws none of them; and either the names of its
 * resource's measures are not known yet, so that a list sorted by one is
 * held from its first rows, or one of them is drawn or sorted by.
 */
export function readsMetrics({
  measures,
  drawn,
  sort,
  visible,
  narrow,
}: {
  /** The names of the resource's measures, once its columns are known. */
  measures: readonly string[] | undefined;
  /** Whether the column of that name is drawn. */
  drawn: (name: string) => boolean;
  sort: Sort | null;
  visible: boolean;
  narrow: boolean;
}): boolean {
  if (!visible || narrow) return false;
  return (
    measures === undefined ||
    measures.some((name) => drawn(name) || name === sort?.column)
  );
}

export const METRICS_NOTES: Readonly<
  Record<Exclude<ServedMetrics, "ready">, string>
> = {
  unavailable:
    "metrics-server does not answer, so there are no CPU or memory figures.",
  forbidden:
    "You may not read metrics here, so there are no CPU or memory figures.",
};

export function metricsNote(
  state: ServedMetrics | null,
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
