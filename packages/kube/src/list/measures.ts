import type { Column, Gvr } from "@twigo/protocol";
import { Changes } from "@twigo/workbench";
import { columnRule } from "../columns";

const NONE: ReadonlySet<string> = new Set();

/**
 * Which columns of each kind are measures, by the space and the kind's
 * group and resource, as the lists of the session learnt it from their
 * columns: one space's cluster may serve the Metrics API and another's not.
 * A batch whose columns say `cpu` or `memory` adds to it and none takes from
 * it: a list's first batches may not know the columns yet, and a list
 * opened again for the kind leaves its measures out of its query at once.
 * A kind whose columns came, with no measure among them, is known to have
 * none in that space.
 */
export class KnownMeasures {
  readonly changes = new Changes();
  readonly #known = new Map<string, ReadonlySet<string>>();

  get(space: string, gvr: Gvr): ReadonlySet<string> {
    return this.#known.get(key(space, gvr)) ?? NONE;
  }

  /** Whether the columns of a list of the kind in the space came, which says its measures, if it has any. */
  knows(space: string, gvr: Gvr): boolean {
    return this.#known.has(key(space, gvr));
  }

  learn(space: string, gvr: Gvr, columns: readonly Column[]): void {
    if (columns.length === 0) return;
    const known = this.get(space, gvr);
    const names = columns
      .filter((column) => columnRule(gvr, column).metric)
      .map((column) => column.name);
    if (this.knows(space, gvr) && names.every((name) => known.has(name))) {
      return;
    }
    this.#known.set(key(space, gvr), new Set([...known, ...names]));
    this.changes.emit();
  }
}

function key(space: string, { group, resource }: Gvr): string {
  return `${space}\n${group}/${resource}`;
}
