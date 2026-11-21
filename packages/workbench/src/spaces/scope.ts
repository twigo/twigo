export const ALL_NAMESPACES = "All namespaces";

/** A scope as it is written wherever it is kept: sorted and with no name twice, so one set is one list URI. */
export function scopeNames(names: readonly string[]): string[] {
  return [...new Set(names)].sort();
}

/** What a scope says: its first name and how many follow, or `All namespaces`, every name in one line, and that line as a tooltip says it. */
export function scopeWords(namespaces: readonly string[]): {
  readonly name: string;
  readonly more: number;
  readonly all: string;
  readonly tooltip: string;
} {
  const [first, ...rest] = namespaces;
  if (first === undefined) {
    return {
      name: ALL_NAMESPACES,
      more: 0,
      all: ALL_NAMESPACES,
      tooltip: ALL_NAMESPACES,
    };
  }
  const all = namespaces.join(", ");
  return {
    name: first,
    more: rest.length,
    all,
    tooltip: rest.length === 0 ? `Namespace: ${first}` : `Namespaces: ${all}`,
  };
}
