import type { Cell, Resource } from "@twigo/protocol";
import type { Selected } from "./selection";

/**
 * What a selected row's cells say of its object, as context keys of its
 * list, so a menu offers Uncordon only on a cordoned node, Resume only on a
 * suspended Job or CronJob, and neither Suspend nor Resume on a Job that
 * ended. The cells are as kube-apiserver prints them (kind 1.37,
 * 2026-11-08; kubernetes v1.37.1, `pkg/printers/internalversion/printers.go`):
 * a node's Status `Ready,SchedulingDisabled`, a Job's Status `Suspended`, or
 * `Complete`, `Failed`, `Terminating`, `FailureTarget` or `SuccessCriteriaMet`
 * once it ends, a CronJob's Suspend `True`.
 */
const STATES: readonly {
  readonly key: string;
  readonly group: string;
  readonly kind: string;
  readonly column: string;
  readonly holds: (cell: Cell | undefined) => boolean;
}[] = [
  {
    key: "resource.cordoned",
    group: "",
    kind: "Node",
    column: "Status",
    holds: (cell) =>
      typeof cell === "string" &&
      cell.split(",").includes("SchedulingDisabled"),
  },
  {
    key: "resource.suspended",
    group: "batch",
    kind: "Job",
    column: "Status",
    holds: (cell) => cell === "Suspended",
  },
  {
    key: "resource.ended",
    group: "batch",
    kind: "Job",
    column: "Status",
    holds: (cell) =>
      typeof cell === "string" &&
      [
        "Complete",
        "Failed",
        "Terminating",
        "FailureTarget",
        "SuccessCriteriaMet",
      ].includes(cell),
  },
  {
    key: "resource.suspended",
    group: "batch",
    kind: "CronJob",
    column: "Suspend",
    holds: (cell) => cell === "True",
  },
];

/** The keys of the selected row's state, for its resource's kind. */
export function rowState(
  resource: Resource,
  selected: Selected | undefined,
): Record<string, boolean> {
  const keys: Record<string, boolean> = {};
  for (const state of STATES) {
    if (state.group !== resource.gvr.group || state.kind !== resource.kind) {
      continue;
    }
    const at = selected?.columns.findIndex(
      (column) => column.name === state.column,
    );
    keys[state.key] =
      selected !== undefined &&
      at !== undefined &&
      state.holds(selected.row.cells[at]);
  }
  return keys;
}
