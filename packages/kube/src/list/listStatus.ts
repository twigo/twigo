import {
  REFUSED,
  type Column,
  type Parts,
  type ValueCount,
  type ViewState,
} from "@twigo/protocol";
import { Changes } from "@twigo/workbench";

export interface ListStatus {
  readonly title: string;
  readonly total: number;
  readonly status: ViewState;
  readonly parts: Parts;
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

/** Whether every part has listed or been refused, so nothing more is on its way. */
export function settled({ unready }: Parts): boolean {
  return unready.every(({ shown, state }) => shown || REFUSED.has(state.state));
}

export function leavesOut({ unready }: Parts): boolean {
  return unready.some(({ shown }) => !shown);
}

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
    a.parts === b.parts &&
    JSON.stringify(a.status) === JSON.stringify(b.status)
  );
}
