import type { Column, Gvr, Row } from "@twigo/protocol";
import { Changes } from "@twigo/workbench";

export interface Selected {
  readonly gvr: Gvr;
  readonly kind: string;
  /** Whether the resource lives in namespaces, as discovery says. */
  readonly namespaced: boolean;
  readonly columns: readonly Column[];
  readonly row: Row;
  /** Open the row's details, as going to a resource does. */
  readonly reveal?: boolean;
}

/**
 * A row's object, from its ID: `context/namespace/name`, or `context/name`
 * when cluster-scoped. A context's name may hold slashes, as an EKS
 * cluster's ARN does, and a namespace's or object's never does, so the ID
 * is read from the right.
 */
export function objectOf({ row, namespaced }: Selected): {
  namespace?: string;
  name: string;
} {
  const parts = row.id.split("/");
  const name = parts.pop() ?? "";
  const namespace = namespaced ? parts.pop() : undefined;
  return namespace === undefined ? { name } : { namespace, name };
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
