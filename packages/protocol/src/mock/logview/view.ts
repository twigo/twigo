import { IpcError } from "../../error";
import type {
  Bucket,
  Histogram,
  LevelFilter,
  LogAround,
  LogEntries,
  LogEntry,
  LogMatches,
  LogView,
  LogWindow,
  TextRange,
} from "../../generated";
import { lowerAscii, parseText, type TextFilter } from "../query";
import type { Dropped, Entry, Judged, Kind, LogBuffer } from "./buffer";
import { time } from "./line";

/** The matches whose entries a batch lists. */
const MATCHES = 10_000;
/** The histogram's spans. */
export const BUCKETS = 60;

/** The search: its matches in a text, in UTF-16 units, none empty. */
type Search = (text: string) => TextRange[];

/**
 * A view, checked once, as Rust's `logs::view` checks it: its filter's and
 * search's regexes parse, and its range's times.
 */
export interface Spec {
  readonly level: LevelFilter;
  readonly filter: TextFilter | null;
  readonly search: Search | null;
  /** Nanoseconds since the Unix epoch, `to` exclusive. */
  readonly range: readonly [bigint, bigint] | null;
}

/** Refuses a filter or a search that is no regex, and a range that is no time. */
export function spec(view: LogView): Spec {
  const filter = view.filter === null ? null : parseText(view.filter);
  const search = view.search === null ? null : searcher(view.search);
  const range = view.range
    ? ([instant(view.range.from), instant(view.range.to)] as const)
    : null;
  return { level: view.level, filter, search, range };
}

function instant(text: string): bigint {
  const at = time(text);
  if (at === null) {
    throw new IpcError(
      "invalidInput",
      `${JSON.stringify(text)} is no RFC 3339 time`,
    );
  }
  return at;
}

function trimAscii(text: string): string {
  return text.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
}

/**
 * A substring in any case of ASCII letters, or a regex between slashes,
 * also in any case, as the filter reads them without its negation; null
 * for no search.
 */
function searcher(source: string): Search | null {
  const text = trimAscii(source);
  if (text.length >= 2 && text.startsWith("/") && text.endsWith("/")) {
    const pattern = text.slice(1, -1);
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "gi");
    } catch (error) {
      throw new IpcError(
        "invalidInput",
        `the search /${pattern}/ is no regex: ${String(error)}`,
      );
    }
    return (line) =>
      [...line.matchAll(regex)]
        .filter((match) => match[0].length > 0)
        .map((match) => ({
          start: match.index,
          end: match.index + match[0].length,
        }));
  }
  if (text === "") return null;
  const needle = lowerAscii(text);
  return (line) => {
    const haystack = lowerAscii(line);
    const found: TextRange[] = [];
    for (
      let at = haystack.indexOf(needle);
      at >= 0;
      at = haystack.indexOf(needle, at + needle.length)
    ) {
      found.push({ start: at, end: at + needle.length });
    }
    return found;
  };
}

function levelKeeps(filter: LevelFilter, kind: Kind & { type: "line" }) {
  switch (filter) {
    case "all":
      return true;
    case "warn":
      return kind.level === "warn" || kind.level === "error";
    case "error":
      return kind.level === "error";
  }
}

/** What it makes of an entry, its range aside; markers pass. */
export function judge(spec: Spec, kind: Kind): Judged {
  if (kind.type !== "line") return { passes: true, hits: 0 };
  const passes =
    levelKeeps(spec.level, kind) && (spec.filter?.keeps([kind.text]) ?? true);
  const hits = passes && spec.search ? spec.search(kind.text).length : 0;
  return { passes, hits };
}

/** Whether it keeps an entry at `at` it judged so. */
export function keeps(spec: Spec, at: bigint, judged: Judged): boolean {
  if (!judged.passes) return false;
  if (!spec.range) return true;
  const [from, to] = spec.range;
  return from <= at && at < to;
}

/** One of the view's entries: the `Dropped` entry, or one of the buffer's. */
type Shown = { readonly dropped: Dropped } | Entry;

/** The view's entries in order. */
function shown(buffer: LogBuffer, spec: Spec): Shown[] {
  const kept: Shown[] = buffer.entries.filter((entry) =>
    keeps(spec, entry.at, entry.judged),
  );
  return buffer.dropped ? [{ dropped: buffer.dropped }, ...kept] : kept;
}

export function total(buffer: LogBuffer, spec: Spec): number {
  return shown(buffer, spec).length;
}

/** The entries a window reads, with the search's marks. */
export function entries(
  buffer: LogBuffer,
  spec: Spec,
  window: LogWindow,
): LogEntries {
  const all = shown(buffer, spec);
  const total = all.length;
  let start: number;
  let end: number;
  let around: LogAround | null = null;
  switch (window.type) {
    case "tail":
      start = Math.max(0, total - window.count);
      end = total;
      break;
    case "range":
      start = Math.min(window.start, total);
      end = Math.min(Math.max(window.end, start), total);
      break;
    case "around": {
      const index = place(buffer, spec, window.id);
      start = Math.max(0, index - window.before);
      end = Math.min(index + window.after, total);
      around = { id: window.id, index };
      break;
    }
  }
  return {
    start,
    entries: all.slice(start, end).map((each) => wire(each, spec)),
    around,
  };
}

/**
 * Where the entry with `id` stands in the view: at its index while the
 * view keeps it, else where its time, ties by id, places it, and at the
 * view's start once the buffer no longer holds it.
 */
function place(buffer: LogBuffer, spec: Spec, id: number): number {
  const entry = buffer.entries.find((each) => each.id === id);
  if (!entry) return 0;
  const before = buffer.entries.filter(
    (each) =>
      (each.at < entry.at || (each.at === entry.at && each.id < entry.id)) &&
      keeps(spec, each.at, each.judged),
  ).length;
  return (buffer.dropped ? 1 : 0) + before;
}

function wire(shown: Shown, spec: Spec): LogEntry {
  if ("dropped" in shown) return { type: "dropped", ...shown.dropped };
  const { id, kind } = shown;
  switch (kind.type) {
    case "line":
      return {
        ...kind,
        id,
        time: rfc3339(shown.at),
        styles: [...kind.styles],
        marks: spec.search ? spec.search(kind.text) : [],
      };
    case "ended":
    case "joined":
    case "left":
      return { ...kind, id };
  }
}

const NANOS = 1_000_000_000n;

/** `a` divided by a positive `b`, rounded down, as Rust's `div_euclid`. */
function floorDiv(a: bigint, b: bigint): bigint {
  const quotient = a / b;
  return a < 0n && quotient * b !== a ? quotient - 1n : quotient;
}

/** RFC 3339 with nine fractional digits, as the kubelet stamps a line. */
export function rfc3339(at: bigint): string {
  const second = floorDiv(at, NANOS);
  const nanos = String(at - second * NANOS).padStart(9, "0");
  return `${whole(second)}.${nanos}Z`;
}

/** `YYYY-MM-DDTHH:MM:SS`. */
function whole(second: bigint): string {
  return new Date(Number(second) * 1000).toISOString().slice(0, 19);
}

/**
 * Every match's entry by its id, in the view's order, the last
 * {@link MATCHES} of them, since a search steps back from the newest.
 */
export function matches(buffer: LogBuffer, spec: Spec): LogMatches {
  let count = 0;
  const ids: number[] = [];
  for (const each of shown(buffer, spec)) {
    if ("dropped" in each) continue;
    const { hits } = each.judged;
    count += hits;
    for (let hit = 0; hit < Math.min(hits, MATCHES); hit++) ids.push(each.id);
  }
  return {
    count,
    entries: ids.slice(Math.max(0, ids.length - MATCHES)),
  };
}

/** Spans a histogram's buckets may take, in seconds: each divides a day, so buckets start at whole times; past a day they double. */
const SPANS = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1_800, 3_600, 7_200, 10_800,
  21_600, 43_200, 86_400,
].map((span) => BigInt(span) * NANOS);

/** The shortest span whose buckets reach back from the span of `last` to `first`. */
function spanOf(first: bigint, last: bigint): bigint {
  const reaches = (span: bigint) =>
    (floorDiv(last, span) + 1n - BigInt(BUCKETS)) * span <= first;
  const found = SPANS.find(reaches);
  if (found !== undefined) return found;
  let span = 2n * 86_400n * NANOS;
  while (!reaches(span)) span *= 2n;
  return span;
}

/**
 * The view's lines over time, its range aside: {@link BUCKETS} spans of
 * the shortest of {@link SPANS} that reach back from the span of the
 * buffer's last line to its first, so the newest lines sit at the right
 * whatever the filter keeps; no buckets, and empty times, while it holds
 * no line.
 */
export function histogram(buffer: LogBuffer): Histogram {
  const lines = buffer.entries.filter((entry) => entry.kind.type === "line");
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (!first || !last) return { from: "", to: "", buckets: [] };
  const span = spanOf(first.at, last.at);
  const to = (floorDiv(last.at, span) + 1n) * span;
  const from = to - BigInt(BUCKETS) * span;
  const buckets: Bucket[] = Array.from({ length: BUCKETS }, () => ({
    lines: 0,
    warnings: 0,
    errors: 0,
  }));
  for (const { at, kind, judged } of lines) {
    if (kind.type !== "line" || !judged.passes) continue;
    const bucket = buckets[Number((at - from) / span)];
    if (!bucket) continue;
    bucket.lines++;
    if (kind.level === "warn") bucket.warnings++;
    if (kind.level === "error") bucket.errors++;
  }
  return {
    from: `${whole(from / NANOS)}Z`,
    to: `${whole(to / NANOS)}Z`,
    buckets,
  };
}
