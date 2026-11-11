/**
 * The checkpoint's live choices (`?variant=busy:input`, several separated by
 * commas or repeated), each group's first the default. This file goes once
 * the owner has chosen, and the code that reads it keeps the choice.
 */
const VARIANTS = {
  busy: ["offer", "input"],
} as const;

type Group = keyof typeof VARIANTS;

export function variant<G extends Group>(
  group: G,
): (typeof VARIANTS)[G][number] {
  const asked = new URLSearchParams(globalThis.location.search)
    .getAll("variant")
    .flatMap((value) => value.split(","));
  const options: readonly string[] = VARIANTS[group];
  const found = options.find((option) => asked.includes(`${group}:${option}`));
  return (found ?? options[0]) as (typeof VARIANTS)[G][number];
}
