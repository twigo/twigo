export const ALL_NAMESPACES = "All namespaces";

/** A scope as it is written wherever it is kept: sorted and with no name twice, so one set is one list URI. */
export function scopeNames(names: readonly string[]): string[] {
  return [...new Set(names)].sort();
}

/** What a scope says: its first name and how many follow, or `All namespaces`, and every name in one line. */
export function scopeWords(namespaces: readonly string[]): {
  readonly name: string;
  readonly more: number;
  readonly all: string;
} {
  const [first, ...rest] = namespaces;
  return first === undefined
    ? { name: ALL_NAMESPACES, more: 0, all: ALL_NAMESPACES }
    : { name: first, more: rest.length, all: namespaces.join(", ") };
}
