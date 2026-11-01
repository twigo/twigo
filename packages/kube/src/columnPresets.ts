import * as v from "valibot";
import type { Gvr } from "@twigo/protocol";
import { Changes, type StateStore } from "@twigo/workbench";

/** Columns the user showed or hid, by name; the rest follow their priority. */
export type ColumnChoices = Readonly<Record<string, boolean>>;

const CHOICES = v.record(v.string(), v.boolean());

/**
 * The columns the user chose, per kind and for every space (ARCHITECTURE
 * 4.4), in the app's state. Choices are kept by column name, so a column a
 * space adds, such as Context, shows unless the user hid it.
 */
export class ColumnPresets {
  readonly changes = new Changes();
  readonly #choices = new Map<string, ColumnChoices>();

  constructor(private readonly state: StateStore) {}

  choices(gvr: Gvr): ColumnChoices {
    const key = presetKey(gvr);
    let choices = this.#choices.get(key);
    if (!choices) {
      choices = this.state.get(null, key, CHOICES, {});
      this.#choices.set(key, choices);
    }
    return choices;
  }

  choose(gvr: Gvr, column: string, shown: boolean): void {
    const key = presetKey(gvr);
    const choices = { ...this.choices(gvr), [column]: shown };
    this.#choices.set(key, choices);
    this.state.set(null, key, choices);
    this.changes.emit();
  }
}

function presetKey(gvr: Gvr): string {
  return `columns/${gvr.group}/${gvr.resource}`;
}
