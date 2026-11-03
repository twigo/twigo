import * as v from "valibot";
import type { Gvr } from "@twigo/protocol";
import { Changes, type StateStore } from "@twigo/workbench";

/** Columns the user showed or hid, by name; the rest follow their priority. */
export type ColumnChoices = Readonly<Record<string, boolean>>;

/** How a kind's tables look, as the user left them (ARCHITECTURE 4.4). */
export interface ListPreset {
  readonly columns: ColumnChoices;
  /** Widths the user dragged or fitted, by column name. */
  readonly widths: Readonly<Record<string, number>>;
  /** The column the rows are grouped by. */
  readonly group?: string;
}

const EMPTY: ListPreset = { columns: {}, widths: {} };

const PRESET = v.object({
  columns: v.fallback(v.record(v.string(), v.boolean()), {}),
  widths: v.fallback(
    v.record(v.string(), v.pipe(v.number(), v.gtValue(0))),
    {},
  ),
  group: v.fallback(v.optional(v.string()), undefined),
});

/**
 * Each kind's columns, widths and grouping, for every space, in the app's
 * state: kept by column name, so a column a space adds, such as Context,
 * shows unless the user hid it.
 */
export class ListPresets {
  readonly changes = new Changes();
  readonly #presets = new Map<string, ListPreset>();

  constructor(private readonly state: StateStore) {}

  get(gvr: Gvr): ListPreset {
    const key = presetKey(gvr);
    let preset = this.#presets.get(key);
    if (!preset) {
      preset = this.state.get(null, key, PRESET, EMPTY);
      this.#presets.set(key, preset);
    }
    return preset;
  }

  showColumn(gvr: Gvr, column: string, shown: boolean): void {
    const preset = this.get(gvr);
    this.#set(gvr, {
      ...preset,
      columns: { ...preset.columns, [column]: shown },
    });
  }

  resize(gvr: Gvr, column: string, width: number): void {
    const preset = this.get(gvr);
    this.#set(gvr, {
      ...preset,
      widths: { ...preset.widths, [column]: Math.round(width) },
    });
  }

  /** Undefined lists the rows ungrouped. */
  groupBy(gvr: Gvr, column: string | undefined): void {
    const { group: _, ...rest } = this.get(gvr);
    this.#set(gvr, column === undefined ? rest : { ...rest, group: column });
  }

  #set(gvr: Gvr, preset: ListPreset): void {
    const key = presetKey(gvr);
    this.#presets.set(key, preset);
    this.state.set(null, key, preset);
    this.changes.emit();
  }
}

function presetKey(gvr: Gvr): string {
  return `list/${gvr.group}/${gvr.resource}`;
}
