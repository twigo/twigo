import type { Column, ValueCount, ViewState } from "@twigo/protocol";
import { Changes } from "@twigo/workbench";

export interface ListStatus {
  readonly title: string;
  readonly total: number;
  readonly status: ViewState;
  readonly columns: readonly Column[];
  /** Rows per value of the list's status column, when it has one. */
  readonly counts: readonly ValueCount[];
}

/** What each open list editor shows, by URI, for the status bar, the explorer and its own title. */
export class ListStatuses {
  readonly changes = new Changes();
  readonly #lists = new Map<string, ListStatus>();

  get(uri: string): ListStatus | undefined {
    return this.#lists.get(uri);
  }

  set(uri: string, status: ListStatus | undefined): void {
    const before = this.#lists.get(uri);
    if (status && before && same(before, status)) return;
    if (status) this.#lists.set(uri, status);
    else this.#lists.delete(uri);
    this.changes.emit();
  }
}

export const SHOWS_ROWS = new Set<ViewState["state"]>([
  "ready",
  "relisting",
  "stale",
]);

export function stateLabel(status: ViewState): string | undefined {
  switch (status.state) {
    case "queued":
      return "Waiting for a stream slot";
    case "connecting":
      return "Connecting…";
    case "syncing":
      return `Loading · ${status.loaded.toLocaleString("en")}`;
    case "relisting":
      return "Relisting…";
    case "stale":
      return "No updates · reconnecting";
    default:
      return undefined;
  }
}

/** What shows of a list is the same, so that a batch that changes only a measure repaints neither the status bar nor the explorer. */
function same(a: ListStatus, b: ListStatus): boolean {
  return (
    a.title === b.title &&
    a.total === b.total &&
    a.columns === b.columns &&
    a.counts === b.counts &&
    JSON.stringify(a.status) === JSON.stringify(b.status)
  );
}
