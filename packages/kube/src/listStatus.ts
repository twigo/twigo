import type { ViewState } from "@twigo/protocol";
import { Changes } from "@twigo/workbench";

export interface ListStatus {
  readonly title: string;
  readonly total: number;
  readonly status: ViewState;
}

/** What each open list editor shows, by URI, for the status bar. */
export class ListStatuses {
  readonly changes = new Changes();
  readonly #lists = new Map<string, ListStatus>();

  get(uri: string): ListStatus | undefined {
    return this.#lists.get(uri);
  }

  set(uri: string, status: ListStatus | undefined): void {
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
