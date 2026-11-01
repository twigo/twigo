import type { Backend, Cell, Column, ListBatch, RowId } from "@twigo/protocol";

/** A cell a batch changed, with what it now reads. */
export interface CellChange {
  readonly id: RowId;
  readonly column: string;
  readonly text: string;
}

export type BatchListener = (
  at: number,
  batch: ListBatch,
  changed: readonly CellChange[],
) => void;

/** What one list subscription received, stamped on arrival, before the view applies it. */
export class ListProbe {
  columns: readonly Column[] = [];
  total = 0;
  start = 0;
  ids: readonly RowId[] = [];
  readonly #cells = new Map<RowId, readonly Cell[]>();
  readonly #listeners = new Set<BatchListener>();

  listen(listener: BatchListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The row's index in the whole sorted list, or -1 outside the window. */
  indexOf(id: RowId): number {
    const at = this.ids.indexOf(id);
    return at < 0 ? -1 : this.start + at;
  }

  cells(id: RowId): readonly Cell[] | undefined {
    return this.#cells.get(id);
  }

  record(at: number, batch: ListBatch): void {
    this.total = batch.total;
    if (batch.columns) this.columns = batch.columns;
    if (batch.window) {
      this.start = batch.window.start;
      this.ids = batch.window.ids;
    }
    const changed: CellChange[] = [];
    for (const row of batch.upserts) {
      const before = this.#cells.get(row.id);
      row.cells.forEach((cell, i) => {
        const column = this.columns[i]?.name;
        if (before && column && cell !== before[i]) {
          changed.push({ id: row.id, column, text: String(cell ?? "") });
        }
      });
      this.#cells.set(row.id, row.cells);
    }
    for (const listener of this.#listeners) listener(at, batch, changed);
  }
}

/** A backend that passes everything through and records each list subscription's batches. */
export class Probe {
  readonly lists: ListProbe[] = [];
  readonly backend: Backend;
  readonly #opened = new Set<(list: ListProbe) => void>();

  constructor(inner: Backend) {
    this.backend = {
      invoke: (command, request) => inner.invoke(command, request),
      subscribe: (command, request, onMessage) => {
        if (command !== "list_subscribe") {
          return inner.subscribe(command, request, onMessage);
        }
        const list = new ListProbe();
        this.lists.push(list);
        for (const opened of this.#opened) opened(list);
        return inner.subscribe(command, request, (message) => {
          list.record(performance.now(), message as ListBatch);
          onMessage(message);
        });
      },
    };
  }

  /** The next list subscription to open. */
  next(): Promise<ListProbe> {
    return new Promise((resolve) => {
      const opened = (list: ListProbe) => {
        this.#opened.delete(opened);
        resolve(list);
      };
      this.#opened.add(opened);
    });
  }
}
