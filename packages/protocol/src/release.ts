import { FrameAcks } from "./acks";
import type { Backend } from "./backend";
import { IpcError, toIpcError } from "./error";
import type {
  IpcError as Wire,
  Overview,
  ReleaseBatch,
  ReleaseManifest,
  ReleaseParts,
  ReleaseRef,
  ReleaseValues,
  RevisionLine,
  Scrubbed,
  SubscriptionId,
  ViewState,
} from "./generated";

export interface ReleaseSnapshot {
  readonly seq: number;
  readonly status: ViewState;
  /** False until a revision is listed, and once none is left. */
  readonly exists: boolean;
  /** The revision the parts are of. */
  readonly revision: number | undefined;
  /** The highest revision Helm keeps. */
  readonly latest: number | undefined;
  readonly problem: Wire | undefined;
  readonly overview: Overview | undefined;
  readonly notes: Scrubbed | undefined;
  readonly description: Scrubbed | undefined;
  readonly values: ReleaseValues | undefined;
  readonly manifest: ReleaseManifest | undefined;
  readonly history: readonly RevisionLine[] | undefined;
}

export const INITIAL_RELEASE: ReleaseSnapshot = {
  seq: 0,
  status: { state: "connecting" },
  exists: false,
  revision: undefined,
  latest: undefined,
  problem: undefined,
  overview: undefined,
  notes: undefined,
  description: undefined,
  values: undefined,
  manifest: undefined,
  history: undefined,
};

/** What an open release's views ask for, and the revision they follow: null for the latest. */
export interface ReleaseAsk {
  readonly revision: number | null;
  readonly parts: ReleaseParts;
}

/**
 * One open release as a store for `useSyncExternalStore`, a release editor's
 * or the inspector's (ARCHITECTURE 4.3). Rust follows only the parts its views
 * show of the revision they follow, and each batch carries the parts that
 * changed; a part of one revision is never shown beside another's, so the
 * snapshot drops what it holds when the revision moves.
 */
export class ReleaseView {
  readonly #backend: Backend;
  readonly #listeners = new Set<() => void>();
  #snapshot = INITIAL_RELEASE;
  #id: SubscriptionId | undefined;
  readonly #opened: Promise<SubscriptionId>;
  #ask: ReleaseAsk;
  #sent: ReleaseAsk;
  readonly #acks = new FrameAcks(
    (id, seq) => this.#backend.invoke("helm_release_ack", { id, seq }),
    () => this.#closed,
    (error) => {
      this.#fail(error);
    },
  );
  #closed = false;

  constructor(backend: Backend, release: ReleaseRef, ask: ReleaseAsk) {
    this.#backend = backend;
    this.#ask = ask;
    this.#sent = ask;
    this.#opened = backend.subscribe(
      "helm_release_open",
      { release, revision: ask.revision, parts: ask.parts },
      (batch) => {
        this.#apply(batch);
      },
    );
    this.#opened.then(
      (id) => {
        this.#id = id;
        if (this.#closed) {
          void this.#backend.invoke("helm_release_close", id);
          return;
        }
        if (!sameAsk(this.#ask, this.#sent)) this.#send();
        this.#acks.opened(id);
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

  readonly getSnapshot = (): ReleaseSnapshot => this.#snapshot;

  setAsk(ask: ReleaseAsk): void {
    if (this.#closed || sameAsk(ask, this.#ask)) return;
    this.#ask = ask;
    if (this.#id !== undefined) this.#send();
  }

  /** Its subscription's id, which a Reveal names it by, once it is open. */
  id(): Promise<SubscriptionId> {
    return this.#opened.then((id) => {
      if (this.#closed)
        throw new IpcError("subscription.not-found", "the release is closed");
      return id;
    });
  }

  close(): void {
    this.#closed = true;
    this.#listeners.clear();
    if (this.#id !== undefined) {
      void this.#backend.invoke("helm_release_close", this.#id);
    }
  }

  #send(): void {
    if (this.#id === undefined) return;
    const ask = this.#ask;
    this.#sent = ask;
    this.#backend
      .invoke("helm_release_set_view", {
        id: this.#id,
        revision: ask.revision,
        parts: ask.parts,
      })
      .catch((error: unknown) => {
        this.#fail(error);
      });
  }

  #apply(batch: ReleaseBatch): void {
    if (this.#closed) return;
    const previous = this.#snapshot;
    const kept = batch.exists && batch.revision === previous.revision;
    this.#publish({
      seq: batch.seq,
      status: batch.status,
      exists: batch.exists,
      revision: batch.revision ?? undefined,
      latest: batch.latest ?? undefined,
      problem: batch.problem ?? undefined,
      overview: batch.overview ?? (kept ? previous.overview : undefined),
      notes: batch.notes ?? (kept ? previous.notes : undefined),
      description:
        batch.description ?? (kept ? previous.description : undefined),
      values: batch.values ?? (kept ? previous.values : undefined),
      manifest: batch.manifest ?? (kept ? previous.manifest : undefined),
      history: batch.exists ? (batch.history ?? previous.history) : undefined,
    });
    this.#acks.took(batch.seq);
  }

  #fail(error: unknown): void {
    if (this.#closed) return;
    this.#publish({
      ...this.#snapshot,
      status: { state: "error", error: toIpcError(error) },
    });
  }

  #publish(snapshot: ReleaseSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}

function sameAsk(a: ReleaseAsk, b: ReleaseAsk): boolean {
  return (
    a.revision === b.revision &&
    a.parts.overview === b.parts.overview &&
    a.parts.values === b.parts.values &&
    a.parts.manifest === b.parts.manifest &&
    a.parts.history === b.parts.history
  );
}
