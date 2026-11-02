import type { Backend } from "./backend";
import { IpcError, toIpcError } from "./error";
import type {
  EventList,
  ObjectBatch,
  ObjectParts,
  ObjectQuery,
  Overview,
  Related,
  SubscriptionId,
  ViewState,
} from "./generated";

export interface ObjectSnapshot {
  readonly seq: number;
  readonly status: ViewState;
  /** False until the object is listed, and once it is deleted. */
  readonly exists: boolean;
  readonly overview: Overview | undefined;
  /** The object's JSON, managedFields dropped and a Secret's values replaced by their sizes. */
  readonly manifest: string | undefined;
  readonly events: EventList | undefined;
  readonly related: Related | undefined;
}

export const INITIAL_OBJECT: ObjectSnapshot = {
  seq: 0,
  status: { state: "connecting" },
  exists: false,
  overview: undefined,
  manifest: undefined,
  events: undefined,
  related: undefined,
};

/**
 * One open object as a store for `useSyncExternalStore`, the drawer's or a
 * resource editor's (ARCHITECTURE 4.3). Rust follows only the parts its
 * views show, and each batch carries the parts that changed; it is
 * acknowledged on the next animation frame, as a list's is.
 */
export class ObjectView {
  readonly #backend: Backend;
  readonly #listeners = new Set<() => void>();
  #snapshot = INITIAL_OBJECT;
  #id: SubscriptionId | undefined;
  #parts: ObjectParts;
  #partsSent: ObjectParts;
  #unacked: number | undefined;
  #closed = false;

  constructor(backend: Backend, object: ObjectQuery, parts: ObjectParts) {
    this.#backend = backend;
    this.#parts = parts;
    this.#partsSent = parts;
    backend
      .subscribe("object_open", { object, parts }, (batch) => {
        this.#apply(batch);
      })
      .then(
        (id) => {
          this.#id = id;
          if (this.#closed) {
            void this.#backend.invoke("object_close", id);
            return;
          }
          if (!sameParts(this.#parts, this.#partsSent)) this.#sendParts();
          if (this.#unacked !== undefined) this.#ack(this.#unacked);
        },
        (error: unknown) => {
          this.#fail(error);
        },
      );
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): ObjectSnapshot => this.#snapshot;

  setParts(parts: ObjectParts): void {
    if (this.#closed || sameParts(parts, this.#parts)) return;
    this.#parts = parts;
    if (this.#id !== undefined) this.#sendParts();
  }

  /** The values of a ConfigMap's keys; null for a key it lacks or holds as binary data. */
  values(keys: readonly string[]): Promise<(string | null)[]> {
    if (this.#id === undefined)
      return Promise.reject(
        new IpcError("unavailable", "the object is not open yet"),
      );
    return this.#backend.invoke("object_values", {
      id: this.#id,
      keys: [...keys],
    });
  }

  close(): void {
    this.#closed = true;
    this.#listeners.clear();
    if (this.#id !== undefined) {
      void this.#backend.invoke("object_close", this.#id);
    }
  }

  #sendParts(): void {
    if (this.#id === undefined) return;
    const parts = this.#parts;
    this.#partsSent = parts;
    this.#backend
      .invoke("object_set_parts", { id: this.#id, parts })
      .catch((error: unknown) => {
        this.#fail(error);
      });
  }

  #apply(batch: ObjectBatch): void {
    if (this.#closed) return;
    const previous = this.#snapshot;
    this.#publish({
      seq: batch.seq,
      status: batch.status,
      exists: batch.exists,
      overview: batch.exists
        ? (batch.overview ?? previous.overview)
        : undefined,
      manifest: batch.exists
        ? (batch.manifest ?? previous.manifest)
        : undefined,
      events: batch.events ?? previous.events,
      related: batch.related ?? previous.related,
    });
    this.#unacked = batch.seq;
    if (this.#id !== undefined) this.#ack(batch.seq);
  }

  #ack(seq: number): void {
    requestAnimationFrame(() => {
      if (this.#closed || this.#id === undefined) return;
      this.#unacked = undefined;
      this.#backend
        .invoke("object_ack", { id: this.#id, seq })
        .catch((error: unknown) => {
          this.#fail(error);
        });
    });
  }

  #fail(error: unknown): void {
    if (this.#closed) return;
    this.#publish({
      ...this.#snapshot,
      status: { state: "error", error: toIpcError(error) },
    });
  }

  #publish(snapshot: ObjectSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}

function sameParts(a: ObjectParts, b: ObjectParts): boolean {
  return (
    a.overview === b.overview &&
    a.manifest === b.manifest &&
    a.events === b.events &&
    a.related === b.related
  );
}
