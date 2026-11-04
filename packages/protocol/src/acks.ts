import type { SubscriptionId } from "./generated";

/**
 * A subscription's flow control (ARCHITECTURE 3.5): each batch is
 * acknowledged on the next animation frame, as Rust waits for before it
 * sends the next, and one that came before the subscription had its id
 * once it has.
 */
export class FrameAcks {
  #id: SubscriptionId | undefined;
  #unacked: number | undefined;

  constructor(
    private readonly send: (
      id: SubscriptionId,
      seq: number,
    ) => Promise<unknown>,
    private readonly closed: () => boolean,
    private readonly fail: (error: unknown) => void,
  ) {}

  opened(id: SubscriptionId): void {
    this.#id = id;
    if (this.#unacked !== undefined) this.#ack(this.#unacked);
  }

  took(seq: number): void {
    this.#unacked = seq;
    if (this.#id !== undefined) this.#ack(seq);
  }

  #ack(seq: number): void {
    requestAnimationFrame(() => {
      const id = this.#id;
      if (this.closed() || id === undefined) return;
      this.#unacked = undefined;
      this.send(id, seq).catch((error: unknown) => {
        this.fail(error);
      });
    });
  }
}
