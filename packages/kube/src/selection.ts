import type { Column, Gvr, Row } from "@twigo/protocol";
import { Changes } from "@twigo/workbench";

export interface Selected {
  readonly gvr: Gvr;
  readonly kind: string;
  readonly columns: readonly Column[];
  readonly row: Row;
  /** Open the row's details, as going to a resource does. */
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
 * Per list editor URI, the row last selected in its table (ARCHITECTURE
 * 4.3), so a list that mounts again selects it again, and two lists of one
 * space keep their own.
 */
export class Selection {
  readonly changes = new Changes();
  readonly #lists = new Map<string, Selected>();

  get(uri: string): Selected | undefined {
    return this.#lists.get(uri);
  }

  set(uri: string, selected: Selected): void {
    if (this.#lists.get(uri) === selected) return;
    this.#lists.set(uri, selected);
    this.changes.emit();
  }
}
