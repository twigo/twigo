import { toIpcError, type Backend } from "@twigo/protocol";
import { Changes } from "@twigo/workbench";

/** A kind whose schema the editor asks for. */
export interface SchemaKind {
  readonly space: string;
  readonly group: string;
  readonly version: string;
  readonly kind: string;
}

export type SchemaState =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly schema: object }
  | { readonly state: "failed"; readonly message: string };

/**
 * The JSON Schema of each kind the person edits (ARCHITECTURE 4.6), asked of
 * the cluster's OpenAPI by `schema_get` the first time an editor of the kind
 * has a change, and kept for the window: a kind whose schema failed to come
 * is not asked again, so its editor works without one.
 */
export class Schemas {
  readonly changes = new Changes();
  readonly #states = new Map<string, SchemaState>();

  constructor(private readonly backend: Backend) {}

  /** What came of asking, none while nothing has asked. */
  get(kind: SchemaKind): SchemaState | undefined {
    return this.#states.get(keyOf(kind));
  }

  /** Asks for the kind's schema unless that was asked already. */
  ensure(kind: SchemaKind): void {
    const key = keyOf(kind);
    if (this.#states.has(key)) return;
    this.#set(key, { state: "loading" });
    void this.#load(kind).then((state) => {
      this.#set(key, state);
    });
  }

  async #load(kind: SchemaKind): Promise<SchemaState> {
    try {
      const text = await this.backend.invoke("schema_get", kind);
      return { state: "ready", schema: JSON.parse(text) as object };
    } catch (error) {
      return { state: "failed", message: toIpcError(error).message };
    }
  }

  #set(key: string, state: SchemaState): void {
    this.#states.set(key, state);
    this.changes.emit();
  }
}

function keyOf({ space, group, version, kind }: SchemaKind): string {
  return JSON.stringify([space, group, version, kind]);
}
