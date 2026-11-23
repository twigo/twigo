import { FrameAcks } from "./acks";
import { IpcError, toIpcError } from "./error";
import type { SubscriptionId, ViewState } from "./generated";

export interface OpenCalls<A, B> {
  readonly open: (onBatch: (batch: B) => void) => Promise<SubscriptionId>;
  readonly ask: (id: SubscriptionId, ask: A) => Promise<unknown>;
  readonly ack: (id: SubscriptionId, seq: number) => Promise<unknown>;
  readonly close: (id: SubscriptionId) => Promise<unknown>;
  /** What it is, for the error its id gives once it is closed: `object`. */
  readonly what: string;
}

/**
 * One open subscription as a store for `useSyncExternalStore` (ARCHITECTURE
 * 4.3): Rust follows only what its views ask for, each batch carries what
 * changed, and it is acknowledged on the next animation frame, as a list's is.
 */
export abstract class OpenView<
  A,
  B extends { readonly seq: number },
  S extends { readonly status: ViewState },
> {
  readonly #calls: OpenCalls<A, B>;
  readonly #listeners = new Set<() => void>();
  #snapshot: S;
  #id: SubscriptionId | undefined;
  readonly #opened: Promise<SubscriptionId>;
  #ask: A;
  #sent: A;
  readonly #acks: FrameAcks;
  #closed = false;

  protected constructor(calls: OpenCalls<A, B>, initial: S, ask: A) {
    this.#calls = calls;
    this.#snapshot = initial;
    this.#ask = ask;
    this.#sent = ask;
    this.#acks = new FrameAcks(
      calls.ack,
      () => this.#closed,
      (error) => {
        this.#fail(error);
      },
    );
    this.#opened = calls.open((batch) => {
      if (this.#closed) return;
      this.#publish(this.next(batch, this.#snapshot));
      this.#acks.took(batch.seq);
    });
    this.#opened.then(
      (id) => {
        this.#id = id;
        if (this.#closed) {
          void calls.close(id);
          return;
        }
        if (!this.same(this.#ask, this.#sent)) this.#send();
        this.#acks.opened(id);
      },
      (error: unknown) => {
        this.#fail(error);
      },
    );
  }

  protected abstract next(batch: B, previous: S): S;

  protected abstract same(a: A, b: A): boolean;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): S => this.#snapshot;

  setAsk(ask: A): void {
    if (this.#closed || this.same(ask, this.#ask)) return;
    this.#ask = ask;
    if (this.#id !== undefined) this.#send();
  }

  /** Its subscription's id, which commands name it by, once it is open: a batch may come before the id. */
  id(): Promise<SubscriptionId> {
    return this.#opened.then((id) => {
      if (this.#closed)
        throw new IpcError(
          "subscription.not-found",
          `the ${this.#calls.what} is closed`,
        );
      return id;
    });
  }

  close(): void {
    this.#closed = true;
    this.#listeners.clear();
    if (this.#id !== undefined) void this.#calls.close(this.#id);
  }

  #send(): void {
    if (this.#id === undefined) return;
    const ask = this.#ask;
    this.#sent = ask;
    this.#calls.ask(this.#id, ask).catch((error: unknown) => {
      this.#fail(error);
    });
  }

  #fail(error: unknown): void {
    if (this.#closed) return;
    this.#publish({
      ...this.#snapshot,
      status: { state: "error", error: toIpcError(error) },
    });
  }

  #publish(snapshot: S): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}
