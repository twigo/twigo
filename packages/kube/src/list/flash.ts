import type { Column, Gvr, ListSnapshot, RowId } from "@twigo/protocol";
import { columnRule } from "../columns";

/** Above this many changed rows in one batch nothing flashes: a rollout would strobe the table. */
export const FLASH_ROW_LIMIT = 8;
const FLASH_MS = 1000;

/**
 * Remembers when each cell last changed, so a flash survives the batches that
 * follow it within its second (ARCHITECTURE 4.4).
 */
export class FlashTracker {
  readonly #changed = new Map<string, number>();
  #seq = 0;
  #columns: readonly Column[] | undefined;
  #still: ReadonlySet<number> = new Set();

  constructor(private readonly gvr: Gvr) {}

  /**
   * A column whose rule does not flash, such as a measure that moves at
   * every poll, neither flashes nor counts toward the limit of rows.
   */
  record(snapshot: ListSnapshot, now: number): void {
    if (snapshot.seq === this.#seq) return;
    this.#seq = snapshot.seq;
    for (const [key, at] of this.#changed) {
      if (now - at >= FLASH_MS) this.#changed.delete(key);
    }
    const flashing = [...snapshot.changed]
      .map(
        ([id, cells]) =>
          [id, cells.filter((c) => !this.#quiet(snapshot, c))] as const,
      )
      .filter(([, cells]) => cells.length > 0);
    if (flashing.length > FLASH_ROW_LIMIT) return;
    for (const [id, cells] of flashing) {
      for (const cell of cells) this.#changed.set(cellKey(id, cell), now);
    }
  }

  #quiet({ columns }: ListSnapshot, cell: number): boolean {
    if (columns !== this.#columns) {
      this.#columns = columns;
      this.#still = new Set(
        columns.flatMap((column, at) =>
          columnRule(this.gvr, column).flash ? [] : [at],
        ),
      );
    }
    return this.#still.has(cell);
  }

  /** When the cell's flash started, until a batch after its second forgets it. */
  since(id: RowId, cell: number): number | undefined {
    return this.#changed.get(cellKey(id, cell));
  }
}

function cellKey(id: RowId, cell: number): string {
  return `${id}\u0000${String(cell)}`;
}
