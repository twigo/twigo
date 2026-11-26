import { FrameAcks } from "./acks";
import type { Backend } from "./backend";
import { IpcError, toIpcError } from "./error";
import { isHelmList, releaseListQuery } from "./helm";
import type {
  Cell,
  Column,
  ListBatch,
  ListQuery,
  Parts,
  Row,
  RowGroup,
  RowId,
  SubscriptionId,
  ValueCount,
  ViewState,
} from "./generated";
import type { ServedMetrics } from "./metrics";

export interface ListSnapshot {
  readonly seq: number;
  /** The number of the view the latest batch reflects: the query `ListView.queryOf` returns. */
  readonly view: number;
  readonly total: number;
  readonly columns: readonly Column[];
  /** Index of `ids[0]` in the whole sorted list. */
  readonly start: number;
  readonly ids: readonly RowId[];
  readonly rows: ReadonlyMap<RowId, Row>;
  readonly status: ViewState;
  /** The upstreams the list reads and those not ready, as the latest batch that said so has them. */
  readonly parts: Parts;
  /** The matching rows per value of the query's `countBy` column. */
  readonly counts: readonly ValueCount[];
  /** The query's `groupBy` groups, in group order. */
  readonly groups: readonly RowGroup[];
  /** Column indexes of the cells the latest batch changed, by row. */
  readonly changed: ReadonlyMap<RowId, readonly number[]>;
  /** Whether the Metrics API answers, once the list has metric columns. */
  readonly metrics: ServedMetrics | null;
}

/** What a list says of its parts until a batch names them, and once it has failed. */
const ONE_PART: Parts = { count: 1, unready: [], omitted: 0 };

/** Before the first batch. */
export const INITIAL_SNAPSHOT: ListSnapshot = {
  seq: 0,
  view: 0,
  total: 0,
  columns: [],
  start: 0,
  ids: [],
  rows: new Map(),
  status: { state: "connecting" },
  parts: ONE_PART,
  counts: [],
  groups: [],
  changed: new Map(),
  metrics: null,
};

/** The part of a query that a list changes in place (ARCHITECTURE 3.4). */
export type ViewQuery = Pick<
  ListQuery,
  "text" | "columns" | "sort" | "countBy" | "groupBy" | "values"
>;

export function viewOf(query: ListQuery): ViewQuery {
  const { text, columns, sort, countBy, groupBy, values } = query;
  return { text, columns, sort, countBy, groupBy, values };
}

/**
 * One list subscription as a store for `useSyncExternalStore`. It applies each
 * batch, then acknowledges its seq on the next animation frame, so Rust sends
 * at most one batch per frame and coalesces the rest (ARCHITECTURE 3.5).
 *
 * Its view changes in place: `setView` numbers each change and sends it, and
 * the snapshot's `view` is that of the latest batch, so `queryOf` says which
 * query the rows on screen answer until the first batch of a change comes.
 */
export class ListView {
  readonly #backend: Backend;
  readonly #listeners = new Set<() => void>();
  #snapshot = INITIAL_SNAPSHOT;
  #id: SubscriptionId | undefined;
  readonly #acks = new FrameAcks(
    (id, seq) => this.#backend.invoke("list_ack", { id, seq }),
    () => this.#closed,
    (error) => {
      this.#fail(error);
    },
  );
  #window: [number, number] | undefined;
  #metrics = false;
  #closed = false;
  /** The queries asked, by view number, from the one the rows on screen answer. */
  readonly #queries = new Map<number, ListQuery>();
  #asked: number;
  /** Why Rust refused the latest view, until another is asked: the status batches cannot clear. */
  #refused: IpcError | undefined;

  /**
   * `metrics` is what the list this one replaces last said, which a view of
   * the same list starts with: Rust's view says none until a scope of its
   * window has answered.
   */
  constructor(
    backend: Backend,
    query: ListQuery,
    metrics: ServedMetrics | null = null,
  ) {
    this.#snapshot =
      metrics === null ? INITIAL_SNAPSHOT : { ...INITIAL_SNAPSHOT, metrics };
    this.#backend = backend;
    this.#queries.set(0, query);
    this.#asked = 0;
    const onBatch = (batch: ListBatch) => {
      this.#apply(batch);
    };
    (isHelmList(query.gvr)
      ? backend.subscribe(
          "helm_list_subscribe",
          releaseListQuery(query),
          onBatch,
        )
      : backend.subscribe("list_subscribe", query, onBatch)
    ).then(
      (id) => {
        this.#id = id;
        if (this.#closed) {
          void this.#backend.invoke("list_unsubscribe", id);
          return;
        }
        if (this.#asked > 0) this.#sendView(this.#asked);
        if (this.#window) this.#sendWindow(...this.#window);
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

  readonly getSnapshot = (): ListSnapshot => this.#snapshot;

  /** The query the rows of `view`, a snapshot's, answer. */
  queryOf(view: number): ListQuery | undefined {
    return this.#queries.get(view);
  }

  /**
   * Changes the view part of the query on the subscription it has: the rows
   * on screen stay until the first batch that names the change, and a text
   * Rust refuses leaves the list in error until the next change.
   */
  setView(view: ViewQuery): void {
    const asked = this.#queries.get(this.#asked);
    if (
      this.#closed ||
      !asked ||
      JSON.stringify(viewOf(asked)) === JSON.stringify(view)
    )
      return;
    this.#asked++;
    this.#queries.set(this.#asked, { ...asked, ...view });
    this.#refused = undefined;
    if (this.#id !== undefined) this.#sendView(this.#asked);
  }

  /** The rows from `start` up to `end` (exclusive), overscan included. */
  setWindow(start: number, end: number): void {
    if (this.#closed) return;
    const window = this.#window;
    if (window?.[0] === start && window[1] === end) return;
    this.#window = [start, end];
    if (this.#id !== undefined) this.#sendWindow(start, end);
  }

  /**
   * Whether the list reads its metric columns now (ARCHITECTURE 3.6). It
   * rides with the window, so a change sends the window again and never
   * opens a new subscription.
   */
  setMetrics(metrics: boolean): void {
    if (this.#closed || metrics === this.#metrics) return;
    this.#metrics = metrics;
    if (this.#id !== undefined && this.#window)
      this.#sendWindow(...this.#window);
  }

  close(): void {
    this.#closed = true;
    this.#listeners.clear();
    if (this.#id !== undefined) {
      void this.#backend.invoke("list_unsubscribe", this.#id);
    }
  }

  #sendView(view: number): void {
    const query = this.#queries.get(view);
    if (this.#id === undefined || !query) return;
    this.#backend
      .invoke("list_set_view", { id: this.#id, view, ...viewOf(query) })
      .catch((error: unknown) => {
        this.#refuse(view, error);
      });
  }

  #sendWindow(start: number, end: number): void {
    if (this.#id === undefined) return;
    this.#backend
      .invoke("list_set_window", {
        id: this.#id,
        start,
        end,
        metrics: this.#metrics,
      })
      .catch((error: unknown) => {
        this.#fail(error);
      });
  }

  #apply(batch: ListBatch): void {
    if (this.#closed) return;
    if (batch.metrics === "absent") {
      this.#fail(
        new IpcError("internal.ipc", "a list was told metrics are absent"),
      );
      return;
    }
    const previous = this.#snapshot;
    const ids = batch.window?.ids ?? previous.ids;
    const rows = new Map<RowId, Row>();
    if (batch.window) {
      for (const id of ids) {
        const row = previous.rows.get(id);
        if (row) rows.set(id, row);
      }
    } else {
      for (const [id, row] of previous.rows) rows.set(id, row);
    }
    const changed = new Map<RowId, number[]>();
    for (const row of batch.upserts) {
      const before = rows.get(row.id);
      if (before) {
        const cells = changedCells(before.cells, row.cells);
        if (cells.length > 0) changed.set(row.id, cells);
      }
      rows.set(row.id, row);
    }
    for (const view of this.#queries.keys()) {
      if (view < batch.view) this.#queries.delete(view);
    }
    this.#publish({
      seq: batch.seq,
      view: batch.view,
      total: batch.total,
      columns: batch.columns ?? previous.columns,
      start: batch.window?.start ?? previous.start,
      ids,
      rows,
      status: this.#refused
        ? { state: "error", error: this.#refused }
        : batch.status,
      parts: batch.parts ?? previous.parts,
      counts: batch.counts ?? previous.counts,
      groups: batch.groups ?? previous.groups,
      changed,
      metrics: batch.metrics ?? previous.metrics,
    });
    this.#acks.took(batch.seq);
  }

  #refuse(view: number, error: unknown): void {
    if (this.#closed || view !== this.#asked) return;
    this.#refused = toIpcError(error);
    this.#publish({
      ...this.#snapshot,
      status: { state: "error", error: this.#refused },
    });
  }

  #fail(error: unknown): void {
    if (this.#closed) return;
    this.#publish({
      ...this.#snapshot,
      status: { state: "error", error: toIpcError(error) },
      parts: ONE_PART,
    });
  }

  #publish(snapshot: ListSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}

function changedCells(
  before: readonly Cell[],
  after: readonly Cell[],
): number[] {
  const changed: number[] = [];
  for (let i = 0; i < after.length; i++) {
    if (before[i] !== after[i]) changed.push(i);
  }
  return changed;
}
