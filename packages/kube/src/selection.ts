import type { Column, Gvr, Row } from "@twigo/protocol";
import { Changes } from "@twigo/workbench";

export interface Selected {
  readonly space: string;
  readonly gvr: Gvr;
  readonly kind: string;
  readonly columns: readonly Column[];
  readonly row: Row;
  /** Open the row's details when its list mounts, as going to a resource does. */
  readonly reveal?: boolean;
}

/** A row's object, from its ID: `context/namespace/name`, or `context/name` when cluster-scoped. */
export function objectOf(row: Row): { namespace?: string; name: string } {
  const [, ...rest] = row.id.split("/");
  const name = rest.pop() ?? "";
  const namespace = rest.join("/");
  return namespace === "" ? { name } : { namespace, name };
}

/**
 * Per space, the row last selected in any of its tables (ARCHITECTURE
 * 4.3), so a list that mounts again selects it again.
 */
export class Selection {
  readonly changes = new Changes();
  readonly #spaces = new Map<string, Selected>();

  get(space: string): Selected | undefined {
    return this.#spaces.get(space);
  }

  set(selected: Selected): void {
    if (this.#spaces.get(selected.space) === selected) return;
    this.#spaces.set(selected.space, selected);
    this.changes.emit();
  }
}
