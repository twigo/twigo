import type { Column, Gvr, Row } from "@twigo/protocol";
import { Changes } from "@twigo/workbench";

export interface Selected {
  readonly space: string;
  readonly gvr: Gvr;
  readonly kind: string;
  readonly columns: readonly Column[];
  readonly row: Row;
}

/**
 * The row the Inspector shows (ARCHITECTURE 4.3): per space, the last one
 * selected in any of its tables, without fetching the object.
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
