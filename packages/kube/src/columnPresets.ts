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
  /** Absent until the first read; a failed read is retried by the next choice. */
  readonly #reads = new Map<string, "reading" | "read" | "failed">();

  constructor(
    private readonly backend: Backend,
    private readonly onError: (error: unknown) => void,
  ) {}

  /** Empty until the saved choices are read. */
  choices(gvr: Gvr): ColumnChoices {
    const key = presetKey(gvr);
    if (!this.#reads.has(key)) this.#load(key);
    return this.#choices.get(key) ?? {};
  }

  /** Before the saved choices are read, it waits for them and saves both. */
  choose(gvr: Gvr, column: string, shown: boolean): void {
    const key = presetKey(gvr);
    this.#choices.set(key, { ...this.#choices.get(key), [column]: shown });
    this.changes.emit();
    const read = this.#reads.get(key);
    if (read === "read") this.#save(key);
    else if (read !== "reading") this.#load(key);
  }

  #load(key: string): void {
    this.#reads.set(key, "reading");
    this.backend.invoke("state_get", key).then(
      (saved) => {
        this.#reads.set(key, "read");
        const chosen = this.#choices.get(key);
        this.#choices.set(key, { ...readChoices(saved), ...chosen });
        this.changes.emit();
        if (chosen) this.#save(key);
      },
      (error: unknown) => {
        this.#reads.set(key, "failed");
        this.onError(error);
      },
    );
  }

  #save(key: string): void {
    this.backend
      .invoke("state_set", {
        key,
        value: JSON.stringify(this.#choices.get(key) ?? {}),
      })
      .catch(this.onError);
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
