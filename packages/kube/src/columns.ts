import type { Column, Gvr } from "@twigo/protocol";

/** Columns of string kind that hold numbers, by `group/resource/column`, aligned to the end as numbers are. */
const NUMERIC: ReadonlySet<string> = new Set(["/pods/Ready"]);

/** Columns every kind shows that only place a row, so they read quieter than its name and state. */
const QUIET: ReadonlySet<string> = new Set(["Namespace"]);

/**
 * A cell's text split into what matters and a grey remainder, by
 * `group/resource/column`: Restarts `3 (28m ago)` → `3` and ` (28m ago)`.
 */
const SPLITS: Readonly<
  Record<string, (text: string) => readonly [string, string]>
> = {
  "/pods/Restarts": (text) => {
    const match = /^(\d+)( \(.+\))$/.exec(text);
    return match?.[1] && match[2] ? [match[1], match[2]] : [text, ""];
  },
};

/** Zero counts are noise beside the ones that are not, by `group/resource/column`. */
const ZERO_QUIET: ReadonlySet<string> = new Set(["/pods/Restarts"]);

function key(gvr: Gvr, column: string): string {
  return `${gvr.group}/${gvr.resource}/${column}`;
}

export function alignsEnd(gvr: Gvr, column: Column): boolean {
  return (
    column.kind === "age" ||
    column.kind === "integer" ||
    column.kind === "number" ||
    NUMERIC.has(key(gvr, column.name))
  );
}

export function quietColumn(column: Column): boolean {
  return column.kind === "age" || QUIET.has(column.name);
}

export interface CellParts {
  readonly text: string;
  readonly rest: string;
  readonly quiet: boolean;
}

export function cellParts(gvr: Gvr, column: string, text: string): CellParts {
  const id = key(gvr, column);
  const [main, rest] = SPLITS[id]?.(text) ?? [text, ""];
  return { text: main, rest, quiet: ZERO_QUIET.has(id) && text === "0" };
}
