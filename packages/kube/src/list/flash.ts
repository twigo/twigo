import type { ListSnapshot, RowId } from "@twigo/protocol";

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

  record(snapshot: ListSnapshot, now: number): void {
    if (snapshot.seq === this.#seq) return;
    this.#seq = snapshot.seq;
    for (const [key, at] of this.#changed) {
      if (now - at >= FLASH_MS) this.#changed.delete(key);
    }
    if (snapshot.changed.size > FLASH_ROW_LIMIT) return;
    for (const [id, cells] of snapshot.changed) {
      for (const cell of cells) this.#changed.set(cellKey(id, cell), now);
    }
  }

  /** When the cell's flash started, until a batch after its second forgets it. */
  since(id: RowId, cell: number): number | undefined {
    return this.#changed.get(cellKey(id, cell));
  }
}

function cellKey(id: RowId, cell: number): string {
  return `${id}\u0000${String(cell)}`;
}
