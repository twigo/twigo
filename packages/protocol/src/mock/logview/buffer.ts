import type { Level, ObjectRef, TextStyle } from "../../generated";

/** What the buffer holds at most (ARCHITECTURE 4.6): entries, and bytes of their text in UTF-8. */
export interface Limits {
  readonly entries: number;
  readonly bytes: number;
}

export const LIMITS: Limits = { entries: 50_000, bytes: 16 * 2 ** 20 };

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

function order(
  a: Pick<Entry, "id" | "at">,
  b: Pick<Entry, "id" | "at">,
): number {
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
 * buffered, bounded by entries and bytes of text, oldest out first but
 * those the session holds, with one `Dropped` entry before them once any
 * went.
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

  /** Adds entries in the order they came, each with the next id and what `judge` makes of it and its time, at its place in time, all of them until `bound`; the ids they got, in that order. */
  insert(
    incoming: readonly Timed[],
    judge: (at: bigint, kind: Kind) => Judged,
  ): number[] {
    const fresh = incoming.map(([at, kind]): Entry => ({
      id: ++this.#next,
      at,
      kind,
      judged: judge(at, kind),
    }));
    const ids = fresh.map((entry) => entry.id);
    fresh.sort(order);
    const first = fresh[0];
    if (!first) return ids;
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
    return ids;
  }

  /** Moves the entry `id`, which stands at `at`, to `to` under its id; false when it no longer holds it. */
  place(id: number, at: bigint, to: bigint): boolean {
    const index = this.#indexOf(id, at);
    const entry = this.#entries[index];
    if (!entry) return false;
    this.#entries.splice(index, 1);
    const moved = { ...entry, at: to };
    this.#entries.splice(this.#before(moved), 0, moved);
    return true;
  }

  /** Whether it holds the entry `id`, which stands at `at`. */
  holds(id: number, at: bigint): boolean {
    return this.#entries[this.#indexOf(id, at)]?.id === id;
  }

  /** Where the entry `id` at `at` stands, or would. */
  #indexOf(id: number, at: bigint): number {
    return this.#before({ id, at });
  }

  /** How many entries come before one at `at` with `id`. */
  #before(entry: Pick<Entry, "id" | "at">): number {
    let low = 0;
    let high = this.#entries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const other = this.#entries[middle];
      if (other && order(other, entry) < 0) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  /**
   * Drops the oldest entries while it holds more than its limits, but keeps
   * those `held` names, first, among the entries it counts, noting the
   * pods whose `joined` it dropped last; then, at that `joined`'s time,
   * where the session places a pod's first entry, it drops those pods'
   * entries too and keeps the others, as Rust's `Buffer::bound` does.
   */
  bound(held: ReadonlySet<number>): void {
    const kept: Entry[] = [];
    let joined: { readonly at: bigint; readonly pods: Set<string> } | undefined;
    let count = 0;
    let next = 0;
    const drop = (entry: Entry) => {
      this.#bytes -= bytes(entry.kind);
      count++;
    };
    while (
      this.#entries.length - next + kept.length > this.#limits.entries ||
      this.#bytes > this.#limits.bytes
    ) {
      const oldest = this.#entries[next];
      if (!oldest) break;
      next++;
      if (held.has(oldest.id)) {
        kept.push(oldest);
        continue;
      }
      if (oldest.kind.type === "joined") {
        if (joined?.at === oldest.at) joined.pods.add(oldest.kind.pod);
        else joined = { at: oldest.at, pods: new Set([oldest.kind.pod]) };
      }
      drop(oldest);
    }
    for (
      let oldest = this.#entries[next];
      joined && oldest?.at === joined.at;
      oldest = this.#entries[next]
    ) {
      next++;
      if (held.has(oldest.id) || !joined.pods.has(oldest.kind.pod))
        kept.push(oldest);
      else drop(oldest);
    }
    this.#entries.splice(0, next, ...kept);
    if (count === 0) return;
    this.#droppedEver += count;
    this.#dropped = {
      id: this.#dropped?.id ?? ++this.#next,
      count: (this.#dropped?.count ?? 0) + count,
    };
  }

  /** Gives a container's last entry its next start while that entry is its end, as the kubelet tells it only later; whether it did. */
  restarts(pod: string, container: string, restarting: string): boolean {
    for (let index = this.#entries.length - 1; index >= 0; index--) {
      const entry = this.#entries[index];
      if (!entry) continue;
      const { kind } = entry;
      if (kind.type !== "line" && kind.type !== "ended") continue;
      if (kind.pod !== pod || kind.container !== container) continue;
      if (kind.type === "line") return false;
      this.#entries[index] = { ...entry, kind: { ...kind, restarting } };
      return true;
    }
    return false;
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
