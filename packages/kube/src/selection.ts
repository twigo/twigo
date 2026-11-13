import type { Column, Gvr, Row, RowId } from "@twigo/protocol";
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
  return objectOfRow(row.id, namespaced);
}

/** A row's object by its ID alone, as `objectOf` reads it. */
export function objectOfRow(
  id: RowId,
  namespaced: boolean,
): { namespace?: string; name: string } {
  const parts = id.split("/");
  const name = parts.pop() ?? "";
  const namespace = namespaced ? parts.pop() : undefined;
  return namespace === undefined ? { name } : { namespace, name };
}

/**
 * Per list editor URI, the row last selected in its table (ARCHITECTURE
 * 4.3), so a list that mounts again selects it again, and two lists of one
 * space keep their own; and the rows the user marked (4.4), which commands
 * of the `resource/marked` menu act on, until the list's filter changes.
 */
export class Selection {
  readonly changes = new Changes();
  readonly #lists = new Map<string, Selected>();
  readonly #marks = new Map<string, ReadonlySet<RowId>>();
  readonly #filters = new Map<string, string>();
  readonly #watchers = new Set<() => void>();

  get(uri: string): Selected | undefined {
    return this.#lists.get(uri);
  }

  set(uri: string, selected: Selected): void {
    if (this.#lists.get(uri) === selected) return;
    this.#lists.set(uri, selected);
    this.changes.emit();
  }

  /**
   * Gives the selected row the measures a poll brought. Only the details
   * print them, so it announces no other selection through `changes`.
   */
  measure(uri: string, row: Row): void {
    const selected = this.#lists.get(uri);
    if (selected?.row.id !== row.id || selected.row === row) return;
    this.#lists.set(uri, { ...selected, row });
    for (const listener of this.#watchers) listener();
  }

  readonly watch = (listener: () => void): (() => void) => {
    this.#watchers.add(listener);
    return () => {
      this.#watchers.delete(listener);
    };
  };

  marks(uri: string): ReadonlySet<RowId> {
    return this.#marks.get(uri) ?? NONE;
  }

  mark(uri: string, ids: readonly RowId[], marked: boolean): void {
    const next = new Set(this.marks(uri));
    for (const id of ids) {
      if (marked) next.add(id);
      else next.delete(id);
    }
    this.#marks.set(uri, next);
    this.changes.emit();
  }

  /**
   * The filter the list's rows now come from, as one string: a new one
   * clears the marks, as a new search clears a selection, so no command
   * acts on rows the list no longer shows.
   */
  filter(uri: string, filter: string): void {
    const before = this.#filters.get(uri);
    this.#filters.set(uri, filter);
    if (before === undefined || before === filter) return;
    if (this.marks(uri).size === 0) return;
    this.#marks.delete(uri);
    this.changes.emit();
  }
}

const NONE: ReadonlySet<RowId> = new Set();
