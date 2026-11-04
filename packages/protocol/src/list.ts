import { FrameAcks } from "./acks";
import type { Backend } from "./backend";
import { toIpcError } from "./error";
import type {
  Cell,
  Column,
  ListBatch,
  ListQuery,
  Row,
  RowGroup,
  RowId,
  SubscriptionId,
  ValueCount,
  ViewState,
} from "./generated";

export interface ListSnapshot {
  readonly seq: number;
  readonly total: number;
  readonly columns: readonly Column[];
  /** Index of `ids[0]` in the whole sorted list. */
  readonly start: number;
  readonly ids: readonly RowId[];
  readonly rows: ReadonlyMap<RowId, Row>;
  readonly status: ViewState;
  /** The matching rows per value of the query's `countBy` column. */
  readonly counts: readonly ValueCount[];
  /** The query's `groupBy` groups, in group order. */
  readonly groups: readonly RowGroup[];
  /** Column indexes of the cells the latest batch changed, by row. */
  readonly changed: ReadonlyMap<RowId, readonly number[]>;
}

/** Before the first batch. */
export const INITIAL_SNAPSHOT: ListSnapshot = {
  seq: 0,
  total: 0,
  columns: [],
  start: 0,
  ids: [],
  rows: new Map(),
  status: { state: "connecting" },
  counts: [],
  groups: [],
  changed: new Map(),
};

/**
 * One list subscription as a store for `useSyncExternalStore`. It applies each
 * batch, then acknowledges its seq on the next animation frame, so Rust sends
 * at most one batch per frame and coalesces the rest (ARCHITECTURE 3.5).
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
  #closed = false;

  constructor(backend: Backend, query: ListQuery) {
    this.#backend = backend;
    backend
      .subscribe("list_subscribe", query, (batch) => {
        this.#apply(batch);
      })
      .then(
        (id) => {
          this.#id = id;
          if (this.#closed) {
            void this.#backend.invoke("list_unsubscribe", id);
            return;
          }
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

  /** The rows from `start` up to `end` (exclusive), overscan included. */
  setWindow(start: number, end: number): void {
    if (this.#closed) return;
    const window = this.#window;
    if (window?.[0] === start && window[1] === end) return;
    this.#window = [start, end];
    if (this.#id !== undefined) this.#sendWindow(start, end);
  }

  close(): void {
    this.#closed = true;
    this.#listeners.clear();
    if (this.#id !== undefined) {
      void this.#backend.invoke("list_unsubscribe", this.#id);
    }
  }

  #sendWindow(start: number, end: number): void {
    if (this.#id === undefined) return;
    this.#backend
      .invoke("list_set_window", { id: this.#id, start, end })
      .catch((error: unknown) => {
        this.#fail(error);
      });
  }

  #apply(batch: ListBatch): void {
    if (this.#closed) return;
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
    this.#publish({
      seq: batch.seq,
      total: batch.total,
      columns: batch.columns ?? previous.columns,
      start: batch.window?.start ?? previous.start,
      ids,
      rows,
      status: batch.status,
      counts: batch.counts ?? previous.counts,
      groups: batch.groups ?? previous.groups,
      changed,
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
