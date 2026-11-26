import type { Column, Gvr, ListSnapshot, RowId } from "@twigo/protocol";
import { columnRule } from "../columns";

/** Above this many changed rows in one batch nothing flashes: a rollout would strobe the table. */
export const FLASH_ROW_LIMIT = 8;
const FLASH_MS = 1000;

/**
 * Remembers when each cell last changed, so a flash survives the batches that
 * follow it within its second (ARCHITECTURE 4.4). A row's flashes are one
 * map, kept as it is until one of them starts or ends, so that a grid draws
 * again the rows whose map changed and no other.
 */
export class FlashTracker {
  readonly #changed = new Map<RowId, ReadonlyMap<string, number>>();
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
    for (const [id, columns] of this.#changed) {
      const alive = [...columns].filter(([, at]) => now - at < FLASH_MS);
      if (alive.length === columns.size) continue;
      if (alive.length === 0) this.#changed.delete(id);
      else this.#changed.set(id, new Map(alive));
    }
    const flashing = [...snapshot.changed]
      .map(([id, cells]) => [id, this.#flashing(snapshot, cells)] as const)
      .filter(([, names]) => names.length > 0);
    if (flashing.length > FLASH_ROW_LIMIT) return;
    for (const [id, names] of flashing) {
      const next = new Map(this.#changed.get(id));
      for (const name of names) next.set(name, now);
      this.#changed.set(id, next);
    }
  }

  #flashing({ columns }: ListSnapshot, cells: readonly number[]): string[] {
    if (columns !== this.#columns) {
      this.#columns = columns;
      this.#still = new Set(
        columns.flatMap((column, at) =>
          columnRule(this.gvr, column).flash ? [] : [at],
        ),
      );
    }
    return cells.flatMap((cell) => {
      const column = columns[cell];
      return column && !this.#still.has(cell) ? [column.name] : [];
    });
  }

  /** When each of a row's flashes started, by column name; none for a row with none. */
  of(id: RowId): ReadonlyMap<string, number> | undefined {
    return this.#changed.get(id);
  }
}
