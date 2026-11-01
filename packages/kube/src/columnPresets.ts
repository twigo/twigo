import type { Backend, Gvr } from "@twigo/protocol";
import { Changes } from "@twigo/workbench";

/** Columns the user showed or hid, by name; the rest follow their priority. */
export type ColumnChoices = Readonly<Record<string, boolean>>;

/**
 * The columns the user chose, per kind and for every space (ARCHITECTURE
 * 4.4), saved through the backend. Choices are kept by column name, so a
 * column a space adds, such as Context, shows unless the user hid it.
 */
export class ColumnPresets {
  readonly changes = new Changes();
  readonly #choices = new Map<string, ColumnChoices>();
  readonly #loading = new Set<string>();

  constructor(
    private readonly backend: Backend,
    private readonly onError: (error: unknown) => void,
  ) {}

  /** Empty until the saved choices are read. */
  choices(gvr: Gvr): ColumnChoices {
    const key = presetKey(gvr);
    if (!this.#choices.has(key)) this.#load(key);
    return this.#choices.get(key) ?? {};
  }

  choose(gvr: Gvr, column: string, shown: boolean): void {
    const key = presetKey(gvr);
    const next = { ...this.choices(gvr), [column]: shown };
    this.#choices.set(key, next);
    this.changes.emit();
    this.backend
      .invoke("state_set", { key, value: JSON.stringify(next) })
      .catch(this.onError);
  }

  #load(key: string): void {
    if (this.#loading.has(key)) return;
    this.#loading.add(key);
    this.backend.invoke("state_get", key).then((saved) => {
      if (!this.#choices.has(key)) {
        this.#choices.set(key, readChoices(saved));
        this.changes.emit();
      }
    }, this.onError);
  }
}

function presetKey(gvr: Gvr): string {
  return `columns/${gvr.group}/${gvr.resource}`;
}

function readChoices(saved: string | null): ColumnChoices {
  if (saved === null) return {};
  try {
    const value: unknown = JSON.parse(saved);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
      ),
    );
  } catch {
    return {};
  }
}
