import type {
  Backend,
  Cell,
  Column,
  Forward,
  ForwardEvent,
  ForwardStarted,
  ListBatch,
  RequestOf,
  RowId,
  ShellEvent,
  ShellMessage,
  SubscriptionId,
  TerminalSession,
} from "@twigo/protocol";

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
  /** The view the latest batch reflects. */
  view = 0;
  readonly #cells = new Map<RowId, readonly Cell[]>();
  readonly #listeners = new Set<BatchListener>();
  readonly #views = new Set<(view: number) => void>();

  listen(listener: BatchListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The number of the next view change sent for this list. */
  nextView(): Promise<number> {
    return new Promise((resolve) => {
      const sent = (view: number) => {
        this.#views.delete(sent);
        resolve(view);
      };
      this.#views.add(sent);
    });
  }

  asked(view: number): void {
    for (const sent of [...this.#views]) sent(view);
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
    this.view = batch.view;
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

const TAIL = 4000;

/** What one session's channel carried: its state, how much output and when, and the end of it. */
export class ShellProbe {
  state: ShellEvent = { state: "connecting" };
  bytes = 0;
  lines = 0;
  /** When the last of it came, in `performance.now()` milliseconds. */
  lastAt = 0;
  tail = "";
  readonly #decoder = new TextDecoder();

  constructor(readonly id: SubscriptionId) {}

  record(at: number, message: ShellMessage): void {
    if ("state" in message) {
      this.state = message;
      return;
    }
    const bytes = new Uint8Array(message);
    this.bytes += bytes.length;
    for (const byte of bytes) if (byte === 10) this.lines += 1;
    this.lastAt = at;
    this.tail = (
      this.tail + this.#decoder.decode(bytes, { stream: true })
    ).slice(-TAIL);
  }
}

/** A backend that passes everything through and records each list subscription's batches, each session's output and the forwards' states. */
export class Probe {
  readonly backend: Backend;
  terminal: TerminalSession | undefined;
  forwardStarted: ForwardStarted | undefined;
  readonly shells: ShellProbe[] = [];
  readonly forwards = new Map<Forward["id"], Forward>();
  readonly #lists = new Map<number, ListProbe>();
  readonly #opened = new Set<(list: ListProbe) => void>();

  constructor(inner: Backend) {
    this.backend = {
      invoke: (command, request) => {
        if (command === "list_set_view") {
          const { id, view } = request as RequestOf<"list_set_view">;
          this.#lists.get(id)?.asked(view);
        }
        const answer = inner.invoke(command, request);
        if (command === "terminal_create") {
          void answer.then((created) => {
            this.terminal = created as TerminalSession;
          });
        } else if (command === "forward_start") {
          void answer.then((started) => {
            this.forwardStarted = started as ForwardStarted;
          });
        }
        return answer;
      },
      subscribe: (command, request, onMessage) => {
        if (command === "shell_open") {
          const shell = new ShellProbe((request as RequestOf<"shell_open">).id);
          this.shells.push(shell);
          return inner.subscribe(command, request, (message) => {
            shell.record(performance.now(), message as ShellMessage);
            onMessage(message);
          });
        }
        if (command === "forwards_watch") {
          return inner.subscribe(command, request, (message) => {
            const event = message as ForwardEvent;
            if (event.event === "changed") {
              this.forwards.set(event.forward.id, event.forward);
            } else this.forwards.delete(event.id);
            onMessage(message);
          });
        }
        if (command !== "list_subscribe") {
          return inner.subscribe(command, request, onMessage);
        }
        const list = new ListProbe();
        for (const opened of this.#opened) opened(list);
        const pending = inner.subscribe(command, request, (message) => {
          list.record(performance.now(), message as ListBatch);
          onMessage(message);
        });
        void pending.then((id) => {
          if (typeof id === "number") this.#lists.set(id, list);
        });
        return pending;
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
