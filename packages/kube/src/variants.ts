/**
 * Which live variant of a checkpoint the page shows: `?variant=kind:chip,offer:bar`
 * names one choice per axis, the first of `choices` when it names none.
 * @todo: remove this file, the variants it does not pick and the pages' branches
 * once the owner has chosen them (M2 step 7's checkpoint).
 */
export function variant<T extends string>(
  axis: string,
  choices: readonly [T, ...T[]],
): T {
  const asked = new URLSearchParams(location.search).get("variant") ?? "";
  for (const entry of asked.split(",")) {
    const [name, value] = entry.split(":");
    const found = choices.find((choice) => choice === value);
    if (name === axis && found !== undefined) return found;
  }
  return choices[0];
}
