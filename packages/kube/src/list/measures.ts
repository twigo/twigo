import type { Column, Gvr } from "@twigo/protocol";
import { Changes } from "@twigo/workbench";
import { columnRule } from "../columns";

const NONE: ReadonlySet<string> = new Set();

/**
 * Which columns of each kind are measures, by the kind's group and
 * resource, as the lists of the session learnt it from their columns. A
 * batch whose columns say `cpu` or `memory` adds to it and none takes from
 * it: a list's first batches may not know the columns yet, and a list
 * opened again for the kind leaves its measures out of its query at once.
 * A kind whose columns came, with no measure among them, is known to have
 * none.
 */
export class KnownMeasures {
  readonly changes = new Changes();
  readonly #known = new Map<string, ReadonlySet<string>>();

  get(gvr: Gvr): ReadonlySet<string> {
    return this.#known.get(key(gvr)) ?? NONE;
  }

  /** Whether the columns of a list of the kind came, which says its measures, if it has any. */
  knows(gvr: Gvr): boolean {
    return this.#known.has(key(gvr));
  }

  learn(gvr: Gvr, columns: readonly Column[]): void {
    if (columns.length === 0) return;
    const known = this.get(gvr);
    const names = columns
      .filter((column) => columnRule(gvr, column).metric)
      .map((column) => column.name);
    if (this.knows(gvr) && names.every((name) => known.has(name))) return;
    this.#known.set(key(gvr), new Set([...known, ...names]));
    this.changes.emit();
  }
}

function key({ group, resource }: Gvr): string {
  return `${group}/${resource}`;
}
