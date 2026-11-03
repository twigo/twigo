import type { Backend } from "./backend";
import { toIpcError, type IpcError } from "./error";
import type {
  Histogram,
  LogBatch,
  LogEntries,
  LogMatches,
  LogPod,
  LogSource,
  LogView,
  LogWindow,
  OpenLogs,
  SubscriptionId,
  ViewState,
} from "./generated";

export interface LogsSnapshot {
  readonly seq: number;
  readonly status: ViewState;
  readonly pods: readonly LogPod[] | undefined;
  /** Entries the view keeps, in or out of the window. */
  readonly total: number;
  readonly window: LogEntries | undefined;
  readonly matches: LogMatches | undefined;
  readonly histogram: Histogram | undefined;
  /** Entries the buffer's bound dropped. */
  readonly dropped: number;
  /**
   * Entries the view kept as they came since its source or view last
   * changed: 0 while Rust has yet to apply a change sent, whose batches
   * still count the old view's.
   */
  readonly arrived: number;
  /**
   * Why Rust refused the source or view last sent, as a filter that is no
   * regex; it keeps the one it had, so the lines show that one until a
   * change is taken.
   */
  readonly refused: IpcError | undefined;
}

export const INITIAL_LOGS: LogsSnapshot = {
  seq: 0,
  status: { state: "connecting" },
  pods: undefined,
  total: 0,
  window: undefined,
  matches: undefined,
  histogram: undefined,
  dropped: 0,
  arrived: 0,
  refused: undefined,
};

/**
 * One logs tab's session as a store for `useSyncExternalStore`
 * (ARCHITECTURE 4.6): the ring buffer lives in Rust, which sends the
 * window's entries; each batch is acknowledged on the next animation
 * frame, as a list's is.
 */
export class LogsSession {
  readonly #backend: Backend;
  readonly #listeners = new Set<() => void>();
  readonly #opened: Promise<SubscriptionId>;
  #snapshot = INITIAL_LOGS;
  #id: SubscriptionId | undefined;
  #source: LogSource;
  #view: LogView;
  #window: LogWindow | undefined;
  #sent: { source: LogSource; view: LogView; window: LogWindow | undefined };
  #unacked: number | undefined;
  #closed = false;
  /** Source and view changes sent and not refused, as Rust counts those it applied. */
  #changes = 0;
  #applied = { arrived: 0, changes: 0 };
  readonly #refusals: {
    source: IpcError | undefined;
    view: IpcError | undefined;
  } = { source: undefined, view: undefined };

  constructor(backend: Backend, request: OpenLogs) {
    this.#backend = backend;
    this.#source = request.source;
    this.#view = request.view;
    this.#sent = {
      source: request.source,
      view: request.view,
      window: undefined,
    };
    this.#opened = backend.subscribe("logs_open", request, (batch) => {
      this.#apply(batch);
    });
    this.#opened.then(
      (id) => {
        this.#id = id;
        if (this.#closed) {
          void this.#backend.invoke("logs_close", id);
          return;
        }
        this.#flush();
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

  readonly getSnapshot = (): LogsSnapshot => this.#snapshot;

  setSource(source: LogSource): void {
    this.#source = source;
    this.#flush();
  }

  setView(view: LogView): void {
    this.#view = view;
    this.#flush();
  }

  setWindow(window: LogWindow): void {
    this.#window = window;
    this.#flush();
  }

  /** Saves the lines through a save dialog: the path, or null when the person cancels. */
  download(filtered: boolean): Promise<string | null> {
    return this.#opened.then((id) =>
      this.#backend.invoke("logs_download", { id, filtered }),
    );
  }

  close(): void {
    this.#closed = true;
    this.#listeners.clear();
    if (this.#id !== undefined)
      void this.#backend.invoke("logs_close", this.#id);
  }

  /** Sends what changed since it last sent, once the session has its id. */
  #flush(): void {
    const id = this.#id;
    if (id === undefined || this.#closed) return;
    const sent = this.#sent;
    const failed = (error: unknown) => {
      this.#fail(error);
    };
    const answer = (kind: "source" | "view") => {
      this.#changes++;
      return {
        taken: () => {
          this.#refuse(kind, undefined);
        },
        refused: (error: unknown) => {
          this.#changes--;
          this.#refuse(kind, toIpcError(error));
        },
      };
    };
    if (!same(sent.source, this.#source)) {
      const { taken, refused } = answer("source");
      this.#backend
        .invoke("logs_set_source", { id, source: this.#source })
        .then(taken, refused);
    }
    if (!same(sent.view, this.#view)) {
      const { taken, refused } = answer("view");
      this.#backend
        .invoke("logs_set_view", { id, view: this.#view })
        .then(taken, refused);
    }
    if (this.#window && !same(sent.window, this.#window)) {
      this.#backend
        .invoke("logs_set_window", { id, window: this.#window })
        .catch(failed);
    }
    this.#sent = {
      source: this.#source,
      view: this.#view,
      window: this.#window,
    };
  }

  #apply(batch: LogBatch): void {
    if (this.#closed) return;
    const previous = this.#snapshot;
    this.#applied = { arrived: batch.arrived, changes: batch.changes };
    this.#publish({
      seq: batch.seq,
      status: batch.status,
      pods: batch.pods ?? previous.pods,
      total: batch.total,
      window: batch.window ?? previous.window,
      matches: batch.matches ?? previous.matches,
      histogram: batch.histogram ?? previous.histogram,
      dropped: batch.dropped,
      arrived: this.#arrived(),
      refused: previous.refused,
    });
    this.#unacked = batch.seq;
    if (this.#id !== undefined) this.#ack(batch.seq);
  }

  #ack(seq: number): void {
    requestAnimationFrame(() => {
      if (this.#closed || this.#id === undefined) return;
      this.#unacked = undefined;
      this.#backend
        .invoke("logs_ack", { id: this.#id, seq })
        .catch((error: unknown) => {
          this.#fail(error);
        });
    });
  }

  /** Each kind stays refused until a change of its own is taken. */
  #refuse(kind: "source" | "view", error: IpcError | undefined): void {
    if (this.#closed) return;
    this.#refusals[kind] = error;
    const refused = this.#refusals.view ?? this.#refusals.source;
    const arrived = this.#arrived();
    if (
      this.#snapshot.refused !== refused ||
      this.#snapshot.arrived !== arrived
    )
      this.#publish({ ...this.#snapshot, refused, arrived });
  }

  #arrived(): number {
    const { arrived, changes } = this.#applied;
    return changes === this.#changes ? arrived : 0;
  }

  #fail(error: unknown): void {
    if (this.#closed) return;
    this.#publish({
      ...this.#snapshot,
      status: { state: "error", error: toIpcError(error) },
    });
  }

  #publish(snapshot: LogsSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}

/** The requests are plain data, so their JSON tells them apart. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
