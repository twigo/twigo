import type { Backend } from "./backend";
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
  ViewState,
} from "./generated";
import { OpenView } from "./openView";

export interface ReleaseSnapshot {
  /**
   * Names what a page holds of the parts it shows, such as a value a person
   * revealed: another number for another view, for the view's next revision,
   * and for a release that went and came back, so that nothing held for one
   * is read for another.
   */
  readonly epoch: number;
  /**
   * Names one life of the release in this view: another number for another
   * view and for a release that went and came back, the same across its
   * revisions, so that what a person chose of the release as a whole, such as
   * the revisions marked in History, holds while it moves.
   */
  readonly life: number;
  readonly status: ViewState;
  /** False until a revision is listed, and once none is left. */
  readonly exists: boolean;
  /** The revision the parts are of. */
  readonly revision: number | undefined;
  /** The highest revision Helm keeps. */
  readonly latest: number | undefined;
  /** The highest revision Helm keeps below `revision`. */
  readonly previous: number | undefined;
  readonly problem: Wire | undefined;
  readonly overview: Overview | undefined;
  readonly notes: Scrubbed | undefined;
  readonly description: Scrubbed | undefined;
  readonly values: ReleaseValues | undefined;
  readonly manifest: ReleaseManifest | undefined;
  readonly history: readonly RevisionLine[] | undefined;
}

export const INITIAL_RELEASE: ReleaseSnapshot = {
  epoch: 0,
  life: 0,
  status: { state: "connecting" },
  exists: false,
  revision: undefined,
  latest: undefined,
  previous: undefined,
  problem: undefined,
  overview: undefined,
  notes: undefined,
  description: undefined,
  values: undefined,
  manifest: undefined,
  history: undefined,
};

let epochs = 0;

/** What an open release's views ask for, and the revision they follow: null for the latest. */
export interface ReleaseAsk {
  readonly revision: number | null;
  readonly parts: ReleaseParts;
}

/**
 * One open release, a release editor's or the inspector's (ARCHITECTURE 4.3).
 * Rust follows only the parts its views show of the revision they follow; a
 * part of one revision is never shown beside another's, so the snapshot drops
 * what it holds when the revision moves.
 */
export class ReleaseView extends OpenView<
  ReleaseAsk,
  ReleaseBatch,
  ReleaseSnapshot
> {
  constructor(backend: Backend, release: ReleaseRef, ask: ReleaseAsk) {
    super(
      {
        open: (onBatch) =>
          backend.subscribe(
            "helm_release_open",
            { release, revision: ask.revision, parts: ask.parts },
            onBatch,
          ),
        ask: (id, next) =>
          backend.invoke("helm_release_set_view", {
            id,
            revision: next.revision,
            parts: next.parts,
          }),
        ack: (id, seq) => backend.invoke("helm_release_ack", { id, seq }),
        close: (id) => backend.invoke("helm_release_close", id),
        what: "release",
      },
      INITIAL_RELEASE,
      ask,
    );
  }

  protected next(
    batch: ReleaseBatch,
    previous: ReleaseSnapshot,
  ): ReleaseSnapshot {
    const kept = batch.exists && batch.revision === previous.revision;
    return {
      epoch: kept ? previous.epoch : ++epochs,
      life: batch.exists && !previous.exists ? ++epochs : previous.life,
      status: batch.status,
      exists: batch.exists,
      revision: batch.revision ?? undefined,
      latest: batch.latest ?? undefined,
      previous: batch.previous ?? undefined,
      problem: batch.problem ?? undefined,
      overview: batch.overview ?? (kept ? previous.overview : undefined),
      notes: batch.notes ?? (kept ? previous.notes : undefined),
      description:
        batch.description ?? (kept ? previous.description : undefined),
      values: batch.values ?? (kept ? previous.values : undefined),
      manifest: batch.manifest ?? (kept ? previous.manifest : undefined),
      history: batch.exists ? (batch.history ?? previous.history) : undefined,
    };
  }

  protected same(a: ReleaseAsk, b: ReleaseAsk): boolean {
    return sameAsk(a, b);
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
