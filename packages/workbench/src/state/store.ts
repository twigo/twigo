import * as v from "valibot";
import type { Backend, StateEntry, StateSnapshot } from "@twigo/protocol";

/** Where a value lives: a space's id, or `null` for the whole app (ARCHITECTURE 4.8). */
export type StateScope = string | null;

/**
 * The UI's state, read once at startup and kept in memory, so reads are
 * synchronous. Each change goes to Rust at once: macOS can end the app
 * without asking the webview, and Rust writes what it holds as it exits.
 * One `state_set` is in flight at a time, so writes land in order, and
 * changes made meanwhile go together in the next.
 */
export class StateStore {
  readonly #app: Map<string, string>;
  readonly #spaces = new Map<string, Map<string, string>>();
  readonly #pending = new Map<string, StateEntry>();
  #sending: Promise<void> | undefined;

  private constructor(
    private readonly backend: Backend,
    snapshot: StateSnapshot,
    private readonly onError: (error: unknown) => void,
  ) {
    this.#app = new Map(Object.entries(snapshot.app));
    for (const [space, values] of Object.entries(snapshot.spaces)) {
      this.#spaces.set(space, new Map(Object.entries(values)));
    }
  }

  static async load(
    backend: Backend,
    onError: (error: unknown) => void,
  ): Promise<StateStore> {
    const snapshot = await backend.invoke("state_load", null);
    return new StateStore(backend, snapshot, onError);
  }

  /**
   * The value of `key` as `schema` reads it, or `fallback` when none is
   * stored or it does not fit. A schema reads field by field with
   * `v.fallback`, so what an older Twigo stored keeps what still fits.
   */
  get<T>(
    scope: StateScope,
    key: string,
    schema: v.GenericSchema<unknown, T>,
    fallback: T,
  ): T {
    const text = this.#values(scope).get(key);
    if (text === undefined) return fallback;
    const read = v.safeParse(schema, JSON.parse(text));
    return read.success ? read.output : fallback;
  }

  /** Stores `value` as JSON; `undefined` stores `null`. */
  set(scope: StateScope, key: string, value: unknown): void {
    const text = JSON.stringify(value ?? null);
    const values = this.#values(scope);
    if (values.get(key) === text) return;
    values.set(key, text);
    this.#pending.set(JSON.stringify([scope, key]), {
      space: scope,
      key,
      value: text,
    });
    this.#sending ??= this.#send();
  }

  /** Resolves once every change so far has reached the backend or failed. */
  async settled(): Promise<void> {
    await this.#sending;
  }

  #values(scope: StateScope): Map<string, string> {
    if (scope === null) return this.#app;
    let values = this.#spaces.get(scope);
    if (!values) {
      values = new Map();
      this.#spaces.set(scope, values);
    }
    return values;
  }

  async #send(): Promise<void> {
    // Changes made in the same task go together.
    await Promise.resolve();
    while (this.#pending.size > 0) {
      const batch = [...this.#pending.values()];
      this.#pending.clear();
      try {
        await this.backend.invoke("state_set", batch);
      } catch (error) {
        this.onError(error);
      }
    }
    this.#sending = undefined;
  }
}
