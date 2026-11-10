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
  readonly component: ComponentType<{ readonly detail: ApprovalDetail }>;
  /** Whether the dialog widens for it, as for a diff. */
  readonly wide: (detail: ApprovalDetail) => boolean;
}

/**
 * How long after an ask shows its allowing choices ignore activation, so a
 * double click, or a click meant for the ask just withdrawn, cannot allow the
 * next. Firefox's `security.notification_enable_delay` is 500 ms for a
 * prompt's buttons, its cancel excepted
 * ([pref](https://github.com/mozilla-firefox/firefox/blob/FIREFOX_159_0_RELEASE/modules/libpref/init/StaticPrefList.yaml#L19153-L19155),
 * [use](https://github.com/mozilla-firefox/firefox/blob/FIREFOX_159_0_RELEASE/toolkit/modules/PopupNotifications.sys.mjs#L2040-L2064));
 * Chromium's dialogs ignore input for the double-click interval, 500 ms off
 * Windows
 * ([protector](https://github.com/chromium/chromium/blob/159.0.8154.0/ui/views/input_event_activation_protector.cc#L21-L22),
 * [interval](https://github.com/chromium/chromium/blob/159.0.8154.0/ui/views/metrics_aura.cc#L15-L22)).
 */
export const ASK_GUARD_MS = 500;

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

  /** `covered` says whether a plan's confirmation is open, which the asks wait behind. */
  constructor(
    private readonly backend: Backend,
    private readonly covered: () => boolean,
  ) {}

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
   * Answers the ask the dialog showed, by its id: an ask withdrawn since is
   * gone, and nothing is sent, rather than whichever ask is current when
   * the call lands. A refusal stays on screen with its words, so the person
   * can type the name again or deny. An ask withdrawn while its answer is on
   * its way closes the dialog, and the broker refuses that answer as gone:
   * the person is told it did not reach the process.
   */
  async answer(
    id: ApprovalId,
    answer: ApprovalAnswer,
    typed?: string,
  ): Promise<void> {
    const ask = this.#asks.find((waiting) => waiting.id === id);
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
      } else {
        notify.warning(
          `${ask.process} no longer asks to ${describeAsk(ask)}, so your answer did not reach it`,
        );
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
        // The answer in flight says how it went itself, and an ask behind a
        // plan's confirmation was not on screen.
        if (this.#answering !== ask.id && !this.covered()) {
          notify.info(`${ask.process} no longer asks to ${describeAsk(ask)}`);
        }
      }
    }
    this.changes.emit();
  }
}
