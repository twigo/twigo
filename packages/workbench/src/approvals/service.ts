import type { ComponentType } from "react";
import type {
  ApprovalAnswer,
  ApprovalAsk,
  ApprovalDetail,
  ApprovalEvent,
  ApprovalId,
  Backend,
} from "@twigo/protocol";
import { toIpcError } from "@twigo/protocol";
import { notify } from "@twigo/ui";
import { Changes } from "../changes";

/**
 * How the dialog of an ask draws what the request would do. The workbench
 * knows nothing of Kubernetes, so the feature that does contributes this
 * (ARCHITECTURE 2.3).
 */
export interface ApprovalDetails {
  /** @todo: drop `folded` with the variants of the checkpoint, once the owner has chosen. */
  readonly component: ComponentType<{
    readonly detail: ApprovalDetail;
    /** Shows no more than what must stay in view, as a diff's warnings. */
    readonly folded: boolean;
  }>;
  /** Whether the dialog widens for it, as for a diff. */
  readonly wide: (detail: ApprovalDetail) => boolean;
}

export function describeAsk({ verb, target, context }: ApprovalAsk): string {
  return `${verb} ${target} on ${context}`;
}

/**
 * The asks that processes make of this window (ARCHITECTURE 6.4): each
 * waits in arrival order and the first is on screen. Rust denies every ask
 * while no window follows, so the watch starts with the window.
 */
export class Approvals {
  readonly changes = new Changes();
  #asks: readonly ApprovalAsk[] = [];
  #details: ApprovalDetails | undefined;
  /** The ask whose answer is on its way, which nothing else answers meanwhile. */
  #answering: ApprovalId | undefined;
  #failure: string | undefined;

  constructor(private readonly backend: Backend) {}

  /** The same array until the next change, for `useSyncExternalStore`. */
  get asks(): readonly ApprovalAsk[] {
    return this.#asks;
  }

  get current(): ApprovalAsk | undefined {
    return this.#asks[0];
  }

  get answering(): boolean {
    return this.#answering !== undefined;
  }

  get failure(): string | undefined {
    return this.#failure;
  }

  get details(): ApprovalDetails | undefined {
    return this.#details;
  }

  registerDetails(details: ApprovalDetails): () => void {
    this.#details = details;
    this.changes.emit();
    return () => {
      if (this.#details !== details) return;
      this.#details = undefined;
      this.changes.emit();
    };
  }

  /** Follows the broker; it sends the asks that wait first, and a later watch replaces this one. */
  async watch(): Promise<void> {
    await this.backend.subscribe("approvals_watch", null, (event) => {
      this.#told(event);
    });
  }

  /**
   * Answers the ask on screen. A refusal stays on screen with its words, so
   * the person can type the name again or deny; an ask that is gone leaves
   * through the broker's withdrawal.
   */
  async answer(answer: ApprovalAnswer, typed?: string): Promise<void> {
    const ask = this.current;
    if (ask === undefined || this.#answering !== undefined) return;
    this.#answering = ask.id;
    this.#failure = undefined;
    this.changes.emit();
    try {
      await this.backend.invoke("approval_answer", {
        id: ask.id,
        answer,
        typed: typed ?? null,
      });
      this.#asks = this.#asks.filter(({ id }) => id !== ask.id);
    } catch (error) {
      if (this.#asks.some(({ id }) => id === ask.id)) {
        this.#failure = toIpcError(error).message;
      }
    }
    this.#answering = undefined;
    this.changes.emit();
  }

  #told(event: ApprovalEvent): void {
    if (event.event === "asked") {
      const known = this.#asks.some(({ id }) => id === event.ask.id);
      this.#asks = known
        ? this.#asks.map((ask) => (ask.id === event.ask.id ? event.ask : ask))
        : [...this.#asks, event.ask];
    } else {
      const index = this.#asks.findIndex(({ id }) => id === event.id);
      const ask = this.#asks[index];
      if (ask === undefined) return;
      this.#asks = this.#asks.filter(({ id }) => id !== event.id);
      if (index === 0) {
        this.#failure = undefined;
        // The answer in flight says how it went itself.
        if (this.#answering !== ask.id) {
          notify.info(`${ask.process} no longer asks to ${describeAsk(ask)}`);
        }
      }
    }
    this.changes.emit();
  }
}
