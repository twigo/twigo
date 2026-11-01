import type { ContextColor, Space } from "@twigo/protocol";
import type { Catalog } from "../spaces/catalog";

/** A space with one context takes that context's colour, if the user gave it one (ARCHITECTURE 4.2). */
export function onlyColor(
  space: Space,
  catalog: Catalog,
): ContextColor | undefined {
  const [only, ...more] = space.contexts;
  if (only === undefined || more.length > 0) return undefined;
  return catalog.find(only)?.color ?? undefined;
}

/** Two letters for a space: the first of its first two words, or its first two. */
export function initials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const [first = "", second] = words;
  return (
    second ? `${first.charAt(0)}${second.charAt(0)}` : first.slice(0, 2)
  ).toUpperCase();
}
