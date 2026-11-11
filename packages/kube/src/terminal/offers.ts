import {
  toIpcError,
  type Backend,
  type KubeconfigOffer,
  type KubeconfigOfferAnswer,
  type KubeconfigOfferEvent,
  type KubeconfigOfferId,
  type SubscriptionId,
} from "@twigo/protocol";
import { Changes } from "@twigo/workbench";

const NONE: readonly string[] = [];

/**
 * The offers this window's terminals make to move what a tool wrote into a
 * terminal's own kubeconfig into the person's (ARCHITECTURE 4.6), and the
 * contexts of proxy terminals that reach their clusters directly. An offer
 * belongs to the window, not to its terminal's tab: it stays until it is
 * answered or the core withdraws it.
 */
export class KubeconfigOffers {
  readonly changes = new Changes();
  #offers: readonly KubeconfigOffer[] = [];
  readonly #answering = new Set<KubeconfigOfferId>();
  readonly #direct = new Map<SubscriptionId, readonly string[]>();
  /** The ids that events told of before the response to the watch, which is older than they are. */
  #early: Set<KubeconfigOfferId> | undefined = new Set();

  constructor(
    private readonly backend: Backend,
    private readonly report: (error: unknown) => void,
  ) {}

  /** The same array until the next change. */
  get offers(): readonly KubeconfigOffer[] {
    return this.#offers;
  }

  answering(id: KubeconfigOfferId): boolean {
    return this.#answering.has(id);
  }

  /** The contexts of a proxy terminal's file that reach their clusters with the person's credentials. */
  direct(session: SubscriptionId): readonly string[] {
    return this.#direct.get(session) ?? NONE;
  }

  /** Follows the core; it answers with the offers that wait, and a later watch of the window replaces this one. */
  async watch(): Promise<void> {
    const waiting = await this.backend.subscribe(
      "kubeconfig_offers_watch",
      null,
      (event) => {
        this.#told(event);
      },
    );
    const early = this.#early;
    this.#early = undefined;
    const rest = waiting.filter(({ id }) => !early?.has(id));
    if (rest.length > 0) {
      this.#offers = [...rest, ...this.#offers];
      this.changes.emit();
    }
  }

  /** `revision` is the one the person was shown, which may be older than the one held here. */
  async answer(
    id: KubeconfigOfferId,
    revision: number,
    answer: KubeconfigOfferAnswer,
  ): Promise<void> {
    if (
      this.#answering.has(id) ||
      !this.#offers.some((offer) => offer.id === id)
    ) {
      return;
    }
    this.#answering.add(id);
    this.changes.emit();
    try {
      await this.backend.invoke("kubeconfig_offer_answer", {
        id,
        revision,
        answer,
      });
      this.#remove(id);
    } catch (error) {
      // The core withdraws an offer that would now move nothing, and only the conflict says why.
      const conflict = toIpcError(error).kind === "conflict";
      if (conflict || this.#offers.some((o) => o.id === id)) this.report(error);
    }
    this.#answering.delete(id);
    this.changes.emit();
  }

  #told(event: KubeconfigOfferEvent): void {
    if (event.event === "direct") {
      if (event.contexts.length === 0) this.#direct.delete(event.session);
      else this.#direct.set(event.session, event.contexts);
      this.changes.emit();
      return;
    }
    this.#early?.add(event.event === "offered" ? event.offer.id : event.id);
    if (event.event === "withdrawn") {
      this.#remove(event.id);
      return;
    }
    const { offer } = event;
    this.#offers = this.#offers.some(({ id }) => id === offer.id)
      ? this.#offers.map((each) => (each.id === offer.id ? offer : each))
      : [...this.#offers, offer];
    this.changes.emit();
  }

  #remove(id: KubeconfigOfferId): void {
    if (!this.#offers.some((offer) => offer.id === id)) return;
    this.#offers = this.#offers.filter((offer) => offer.id !== id);
    this.changes.emit();
  }
}
