import { IpcError } from "../error";
import type {
  Cell,
  Column,
  ListQuery,
  RowGroup,
  RowId,
  ValueCount,
} from "../generated";
import { parseSelector, type Selector } from "./selector";

/** A row as a query reads it: the webview's cells, Namespace included. */
export interface QueryRow {
  readonly id: RowId;
  readonly namespace: string | null;
  /** Unix milliseconds. */
  readonly created: number | null;
  readonly labels: Readonly<Record<string, string>>;
  /** The uid of the object that controls it. */
  readonly controller: string | null;
  readonly cells: readonly Cell[];
}

const NAME = "Name";
const NAMESPACE: Column = { name: "Namespace", kind: "string", priority: 0 };

/**
 * The webview's columns, as Rust's query view makes them (ARCHITECTURE
 * 4.4): the server's, with Namespace after the first for a namespaced
 * resource shown in more than one namespace.
 */
export function queryColumns(
  server: readonly Column[],
  query: ListQuery,
): Column[] {
  const [first, ...rest] = server;
  if (!first || !query.namespaced || new Set(query.namespaces).size === 1) {
    return [...server];
  }
  return [first, NAMESPACE, ...rest];
}

/** A query resolved against its columns; a column the list lacks does nothing. */
export interface CompiledQuery {
  readonly query: ListQuery;
  readonly selector: Selector | null;
  readonly text: TextFilter | null;
  readonly textColumns: readonly number[];
  readonly sort: { at: number; descending: boolean; age: boolean } | null;
  readonly count: number | null;
  readonly group: { at: number; collapsed: ReadonlySet<string> } | null;
  readonly values: { at: number; values: ReadonlySet<string> } | null;
}

/** Refuses a label selector or a regex that does not parse, as Rust does. */
export function compileQuery(
  query: ListQuery,
  columns: readonly Column[],
): CompiledQuery {
  const find = (name: string) => {
    const at = columns.findIndex((column) => column.name === name);
    return at < 0 ? null : at;
  };
  const chosen = (name: string) =>
    query.columns && Object.prototype.hasOwnProperty.call(query.columns, name)
      ? query.columns[name]
      : undefined;
  const textColumns = columns.flatMap((column, at) =>
    column.name === NAME || (chosen(column.name) ?? column.priority === 0)
      ? [at]
      : [],
  );
  const sorted = query.sort === null ? null : find(query.sort.column);
  const at = sorted ?? find(NAME);
  const valuesAt = query.values === null ? null : find(query.values.column);
  const groupAt = query.groupBy === null ? null : find(query.groupBy.column);
  return {
    query,
    selector:
      query.labelSelector === null ? null : parseSelector(query.labelSelector),
    text: query.text === null ? null : parseText(query.text),
    textColumns,
    sort:
      at === null
        ? null
        : {
            at,
            descending: sorted !== null && (query.sort?.descending ?? false),
            age: columns[at]?.kind === "age",
          },
    count: query.countBy === null ? null : find(query.countBy),
    group:
      groupAt === null || query.groupBy === null
        ? null
        : { at: groupAt, collapsed: new Set(query.groupBy.collapsed) },
    values:
      valuesAt === null || query.values === null
        ? null
        : { at: valuesAt, values: new Set(query.values.values) },
  };
}

export interface QueryResult<R> {
  /** The matching rows, sorted, by group first with `groupBy`. */
  readonly rows: R[];
  /** The rows a window reads: those of the groups not collapsed. */
  readonly readable: R[];
  /** With `countBy`: the rows the text and the labels keep, per value. */
  readonly counts: ValueCount[] | null;
  /** With `groupBy`: the groups that hold matching rows, in group order. */
  readonly groups: RowGroup[] | null;
}

/**
 * Filters, counts, groups and sorts as Rust's query view does
 * (ARCHITECTURE 3.4), from scratch on every call; the shared query cases
 * check that the two agree.
 */
export function runQuery<R extends QueryRow>(
  rows: readonly R[],
  compiled: CompiledQuery,
): QueryResult<R> {
  const { query } = compiled;
  const namespaces = new Set(query.namespaces);
  const counted = new Map<string, number>();
  const tallies = new Map<string, Tally>();
  const kept: { row: R; group: string | null }[] = [];
  for (const row of rows) {
    if (
      query.namespaced &&
      namespaces.size > 0 &&
      (row.namespace === null || !namespaces.has(row.namespace))
    ) {
      continue;
    }
    if (compiled.selector && !compiled.selector.matches(row.labels)) continue;
    if (
      query.owners !== null &&
      (row.controller === null || !query.owners.includes(row.controller))
    ) {
      continue;
    }
    if (
      compiled.text &&
      !compiled.text.keeps(
        compiled.textColumns.map((at) => cellText(row.cells[at])),
      )
    ) {
      continue;
    }
    const value =
      compiled.count === null ? null : cellText(row.cells[compiled.count]);
    if (value !== null) increment(counted, value);
    const group =
      compiled.group === null ? null : cellText(row.cells[compiled.group.at]);
    let tally: Tally | undefined;
    if (group !== null) {
      tally = tallies.get(group) ?? { rows: 0, counts: new Map() };
      tallies.set(group, tally);
      if (value !== null) increment(tally.counts, value);
    }
    if (
      compiled.values &&
      !compiled.values.values.has(cellText(row.cells[compiled.values.at]))
    ) {
      continue;
    }
    if (tally) tally.rows++;
    kept.push({ row, group });
  }
  const { sort } = compiled;
  const groupOrder = new Map(
    [...new Set(kept.map(({ group }) => group ?? ""))]
      .sort(compareGroups)
      .map((value, index) => [value, index]),
  );
  const keyed = kept.map(({ row, group }) => ({
    row,
    group,
    rank: groupOrder.get(group ?? "") ?? 0,
    key: sort ? sortKey(row.cells[sort.at], sort.age, row.created) : NULL,
  }));
  keyed.sort((a, b) => {
    const order = compareKeys(a.key, b.key);
    return (
      a.rank - b.rank ||
      (sort?.descending ? -order : order) ||
      natural(a.row.id, b.row.id)
    );
  });
  const collapsed = compiled.group?.collapsed;
  return {
    rows: keyed.map(({ row }) => row),
    readable: keyed
      .filter(({ group }) => group === null || !collapsed?.has(group))
      .map(({ row }) => row),
    counts: query.countBy === null ? null : sortCounts(counted),
    groups:
      compiled.group === null
        ? null
        : [...tallies]
            .filter(([, tally]) => tally.rows > 0)
            .sort(([a], [b]) => compareGroups(a, b))
            .map(([value, tally]) => ({
              value,
              rows: tally.rows,
              counts: sortCounts(tally.counts),
            })),
  };
}

/** A group's matching rows, and its counts before values drop any. */
interface Tally {
  rows: number;
  readonly counts: Map<string, number>;
}

function increment(counts: Map<string, number>, value: string): void {
  counts.set(value, (counts.get(value) ?? 0) + 1);
}

/** Largest first, then by value. */
function sortCounts(counts: ReadonlyMap<string, number>): ValueCount[] {
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || codePoints(a.value, b.value));
}

/** Groups in natural order of their values, the empty value last. */
function compareGroups(a: string | null, b: string | null): number {
  if (a === null || b === null) return 0;
  return Number(a === "") - Number(b === "") || natural(a, b);
}

/** A cell as the filter, the values, the counts and the groups read it. */
function cellText(cell: Cell | undefined): string {
  return cell === null || cell === undefined ? "" : String(cell);
}

/** ASCII letters in lower case, other characters as they are. */
function lowerAscii(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

interface TextFilter {
  keeps(texts: readonly string[]): boolean;
}

/**
 * A substring in any case of ASCII letters; `!` before it negates; `/…/`
 * is a regex in any case, `!/…/` its negation. Until the closing slash the
 * text is a substring. Null for text that keeps every row.
 */
function parseText(source: string): TextFilter | null {
  const text = source.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
  const negated = text.startsWith("!");
  const rest = negated ? text.slice(1) : text;
  let hit: (text: string) => boolean;
  if (rest.length >= 2 && rest.startsWith("/") && rest.endsWith("/")) {
    const pattern = rest.slice(1, -1);
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "i");
    } catch (error) {
      throw new IpcError(
        "invalidInput",
        `the filter /${pattern}/ is no regex: ${String(error)}`,
      );
    }
    hit = (text) => regex.test(text);
  } else if (rest === "") {
    return null;
  } else {
    const needle = lowerAscii(rest);
    hit = (text) => lowerAscii(text).includes(needle);
  }
  return { keeps: (texts) => texts.some(hit) !== negated };
}

/** Variants order first: empty cells, numbers, ratios, then text. */
type SortKey =
  | { readonly rank: 0 }
  | { readonly rank: 1; readonly value: number; readonly then: number | null }
  | { readonly rank: 2; readonly ready: number; readonly total: number }
  | { readonly rank: 3; readonly text: string };

const NULL: SortKey = { rank: 0 };

/** Without negative zero, as Rust's keys. */
function numberKey(value: number, then: number | null = null): SortKey {
  return { rank: 1, value: value + 0, then };
}

function sortKey(
  cell: Cell | undefined,
  age: boolean,
  created: number | null,
): SortKey {
  if (age) return created === null ? NULL : numberKey(-created);
  if (cell === null || cell === undefined) return NULL;
  if (typeof cell === "boolean") return numberKey(cell ? 1 : 0);
  if (typeof cell === "number") return numberKey(cell);
  return textKey(cell);
}

function count(text: string): number | null {
  return /^[0-9]+$/.test(text) ? Number(text) : null;
}

const UNITS: readonly (readonly [string, number])[] = [
  ["y", 365 * 86_400],
  ["d", 86_400],
  ["h", 3_600],
  ["m", 60],
  ["s", 1],
];

/** A duration as Kubernetes prints one, each unit at most once, largest first. */
function duration(text: string): number | null {
  if (text === "") return null;
  let seconds = 0;
  let unit = 0;
  let at = 0;
  while (at < text.length) {
    let end = at;
    while (end < text.length && /[0-9]/.test(text.charAt(end))) end++;
    if (end === at || end === text.length) return null;
    const name = text.charAt(end);
    while (unit < UNITS.length && UNITS[unit]?.[0] !== name) unit++;
    const found = UNITS[unit];
    if (!found) return null;
    seconds += Number(text.slice(at, end)) * found[1];
    unit++;
    at = end + 1;
  }
  return seconds;
}

function textKey(text: string): SortKey {
  const counted = count(text);
  if (counted !== null) return numberKey(counted);
  const seconds = duration(text);
  if (seconds !== null) return numberKey(seconds);
  if (text.endsWith(" ago)")) {
    const rest = text.slice(0, -" ago)".length);
    const at = rest.indexOf(" (");
    if (at >= 0) {
      const restarts = count(rest.slice(0, at));
      const ago = duration(rest.slice(at + 2));
      if (restarts !== null && ago !== null) return numberKey(restarts, ago);
    }
  }
  const slash = text.indexOf("/");
  if (slash >= 0) {
    const ready = count(text.slice(0, slash));
    const total = count(text.slice(slash + 1));
    if (ready !== null && total !== null) return { rank: 2, ready, total };
  }
  return { rank: 3, text };
}

function compareNumbers(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function fraction(ready: number, total: number): number {
  return total === 0 ? 1 : ready / total;
}

function compareKeys(a: SortKey, b: SortKey): number {
  if (a.rank === 1 && b.rank === 1) {
    return (
      compareNumbers(a.value, b.value) ||
      (a.then !== null && b.then !== null
        ? compareNumbers(a.then, b.then)
        : Number(a.then !== null) - Number(b.then !== null))
    );
  }
  if (a.rank === 2 && b.rank === 2) {
    return (
      compareNumbers(fraction(a.ready, a.total), fraction(b.ready, b.total)) ||
      compareNumbers(a.total, b.total) ||
      compareNumbers(a.ready, b.ready)
    );
  }
  if (a.rank === 3 && b.rank === 3) return natural(a.text, b.text);
  return a.rank - b.rank;
}

/** By code points, as Rust compares strings. */
function codePoints(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let at = 0; at < Math.min(x.length, y.length); at++) {
    const order = (x[at]?.codePointAt(0) ?? 0) - (y[at]?.codePointAt(0) ?? 0);
    if (order !== 0) return order;
  }
  return x.length - y.length;
}

/** A character's code point, an ASCII capital as its small letter. */
function foldAscii(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  return code >= 65 && code <= 90 ? code + 32 : code;
}

function digit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

/**
 * Natural order: runs of ASCII digits by their value, other characters one
 * by one with ASCII letters folded to lower case, and a tie by code points.
 */
export function natural(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  let i = 0;
  let j = 0;
  for (;;) {
    const c = x[i];
    const d = y[j];
    if (c === undefined && d === undefined) return codePoints(a, b);
    if (c === undefined) return -1;
    if (d === undefined) return 1;
    if (digit(c) && digit(d)) {
      let p = i;
      while (digit(x[p])) p++;
      let q = j;
      while (digit(y[q])) q++;
      const left = x.slice(i, p).join("").replace(/^0+/, "");
      const right = y.slice(j, q).join("").replace(/^0+/, "");
      const order =
        left.length - right.length ||
        (left < right ? -1 : left > right ? 1 : 0);
      if (order !== 0) return order;
      i = p;
      j = q;
      continue;
    }
    const order = foldAscii(c) - foldAscii(d);
    if (order !== 0) return order;
    i++;
    j++;
  }
}
