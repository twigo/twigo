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
 * The row the Inspector shows (ARCHITECTURE 4.3): the last one selected in
 * any table, without fetching the object.
 */
export class Selection {
  readonly changes = new Changes();
  #current: Selected | undefined;

  get current(): Selected | undefined {
    return this.#current;
  }

  set(selected: Selected | undefined): void {
    if (selected === this.#current) return;
    this.#current = selected;
    this.changes.emit();
  }
}
