import type { Level, ObjectRef, TextStyle } from "../../generated";

/** What the buffer holds at most (ARCHITECTURE 4.6): entries, and bytes of their text in UTF-8. */
export interface Limits {
  readonly entries: number;
  readonly bytes: number;
}

export const LIMITS: Limits = { entries: 50_000, bytes: 32 * 2 ** 20 };

export type Kind =
  | {
      readonly type: "line";
      readonly pod: string;
      readonly container: string;
      readonly level: Level | null;
      readonly text: string;
      readonly styles: readonly TextStyle[];
    }
  | {
      readonly type: "ended";
      readonly pod: string;
      readonly container: string;
      readonly time: string;
      readonly exitCode: number | null;
      readonly reason: string | null;
      readonly restarting: string | null;
    }
  | {
      readonly type: "joined";
      readonly pod: string;
      readonly time: string;
      readonly owner: ObjectRef | null;
    }
  | { readonly type: "left"; readonly pod: string; readonly time: string };

/** An entry as it comes: nanoseconds since the Unix epoch, which order entries, and what it is. */
export type Timed = readonly [at: bigint, kind: Kind];

/** What the view made of an entry, kept so that a new line costs only its own filtering and search. */
export interface Judged {
  /** It passes the level and the filter, its range aside. */
  readonly passes: boolean;
  /** The search's matches in its text. */
  readonly hits: number;
}

export interface Entry {
  readonly id: number;
  readonly at: bigint;
  readonly kind: Kind;
  judged: Judged;
}

/** The `Dropped` entry: its id and how many entries went. */
export interface Dropped {
  readonly id: number;
  readonly count: number;
}

function order(a: Entry, b: Entry): number {
  return a.at < b.at ? -1 : a.at > b.at ? 1 : a.id - b.id;
}

function bytes(kind: Kind): number {
  if (kind.type !== "line") return 0;
  let count = 0;
  for (const char of kind.text) {
    const code = char.codePointAt(0) ?? 0;
    count += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return count;
}

/**
 * A session's buffer as Rust's `logs::buffer` keeps it: the entries of
 * every stream in time order, ties by id, each with an id it keeps while
 * buffered, bounded by entries and bytes of text, oldest out first, with
 * one `Dropped` entry before them once any went.
 */
export class LogBuffer {
  readonly #limits: Limits;
  #entries: Entry[] = [];
  #bytes = 0;
  #next = 0;
  #dropped: Dropped | null = null;
  #droppedEver = 0;

  constructor(limits: Limits = LIMITS) {
    this.#limits = limits;
  }

  /** Adds entries in the order they came, each with the next id and what `judge` makes of it, at its place in time. */
  insert(incoming: readonly Timed[], judge: (kind: Kind) => Judged): void {
    const fresh = incoming.map(([at, kind]): Entry => ({
      id: ++this.#next,
      at,
      kind,
      judged: judge(kind),
    }));
    fresh.sort(order);
    const first = fresh[0];
    if (!first) return;
    for (const entry of fresh) this.#bytes += bytes(entry.kind);
    let split = this.#entries.length;
    while (split > 0) {
      const before = this.#entries[split - 1];
      if (!before || order(before, first) < 0) break;
      split--;
    }
    const later = this.#entries.splice(split);
    let old = 0;
    let added = 0;
    for (;;) {
      const a = later[old];
      const b = fresh[added];
      if (a && (!b || order(a, b) < 0)) {
        this.#entries.push(a);
        old++;
      } else if (b) {
        this.#entries.push(b);
        added++;
      } else {
        break;
      }
    }
    this.#bound();
  }

  #bound(): void {
    let count = 0;
    while (
      this.#entries.length - count > this.#limits.entries ||
      this.#bytes > this.#limits.bytes
    ) {
      const oldest = this.#entries[count];
      if (!oldest) break;
      this.#bytes -= bytes(oldest.kind);
      count++;
    }
    if (count === 0) return;
    this.#entries.splice(0, count);
    this.#droppedEver += count;
    this.#dropped = {
      id: this.#dropped?.id ?? ++this.#next,
      count: (this.#dropped?.count ?? 0) + count,
    };
  }

  /** Empties it for a source read anew; ids go on from where they were. */
  clear(): void {
    this.#entries = [];
    this.#bytes = 0;
    this.#dropped = null;
  }

  /** Judges every entry again, for a new view. */
  judge(judge: (kind: Kind) => Judged): void {
    for (const entry of this.#entries) entry.judged = judge(entry.kind);
  }

  get entries(): readonly Entry[] {
    return this.#entries;
  }

  get dropped(): Dropped | null {
    return this.#dropped;
  }

  /** The entries it dropped since it was made, across clears. */
  get droppedEver(): number {
    return this.#droppedEver;
  }
}
