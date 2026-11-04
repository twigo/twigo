import { useCallback, useEffect, useMemo, useState } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";

/** The keys of a window of rows from its first index, and those of the rows that left it, by index. */
export interface Loaded {
  readonly start: number;
  readonly keys: readonly string[];
  readonly left: ReadonlyMap<number, string>;
}

const NONE: ReadonlyMap<number, string> = new Map();

/**
 * The lines that left the loaded ones, by the index they stand at now, so
 * their rows keep the sizes they were measured at and a new window does
 * not move the lines below them: the window before's and those it kept,
 * each moved as far as the nearest line both windows hold, within `reach`
 * of the loaded lines.
 */
export function leftOf(
  was: Loaded,
  start: number,
  keys: readonly string[],
  reach: number,
  total: number,
): ReadonlyMap<number, string> {
  const now = new Map(keys.map((key, at) => [key, start + at]));
  const first = was.keys.findIndex((key) => now.has(key));
  let last = was.keys.length - 1;
  while (last > first && !now.has(was.keys[last] ?? "")) last--;
  const moved = (at: number) => {
    const key = was.keys[at];
    return key === undefined
      ? undefined
      : (now.get(key) ?? 0) - (was.start + at);
  };
  const above = moved(first);
  const below = moved(last);
  if (above === undefined || below === undefined) return NONE;
  const end = start + keys.length;
  const left = new Map<number, string>();
  const keep = (index: number, key: string) => {
    const at = index + (index < was.start + first ? above : below);
    if (now.has(key) || (at >= start && at < end)) return;
    if (at >= Math.max(0, start - reach) && at < Math.min(total, end + reach))
      left.set(at, key);
  };
  for (const [index, key] of was.left) keep(index, key);
  was.keys.forEach((key, at) => {
    keep(was.start + at, key);
  });
  return left;
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, at) => key === b[at]);
}

/**
 * The rows' keys for the virtualizer, the loaded lines' and those of the
 * lines that left them within `reach`, made anew only when the window
 * does, so the virtualizer lays the rows out again only then or when a
 * size changes; and the keys whose sizes it keeps.
 */
export function useRowKeys(
  start: number,
  keys: readonly string[],
  total: number,
  reach: number,
): {
  keyOf: (index: number) => string | number;
  kept: ReadonlySet<string>;
} {
  const [loaded, setLoaded] = useState<Loaded>({ start, keys, left: NONE });
  if (loaded.start !== start || !sameKeys(loaded.keys, keys))
    setLoaded({ start, keys, left: leftOf(loaded, start, keys, reach, total) });
  const keyOf = useCallback(
    (index: number) =>
      loaded.keys[index - loaded.start] ?? loaded.left.get(index) ?? index,
    [loaded],
  );
  const kept = useMemo(
    () => new Set([...loaded.keys, ...loaded.left.values()]),
    [loaded],
  );
  return { keyOf, kept };
}

/**
 * Sizes are kept by line, so they would keep one for every line that
 * passed: only the rows `kept` keep theirs. A mounted row is measured
 * again only when its size changes, and is one of those or a blank one of
 * the estimate's height.
 */
export function useKeptSizes(
  virtualizer: Pick<Virtualizer<HTMLDivElement, Element>, "itemSizeCache">,
  kept: ReadonlySet<string>,
): void {
  useEffect(() => {
    const sizes = virtualizer.itemSizeCache;
    for (const key of sizes.keys()) {
      if (typeof key !== "string" || !kept.has(key)) sizes.delete(key);
    }
  }, [virtualizer, kept]);
}
