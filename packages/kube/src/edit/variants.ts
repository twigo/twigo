/**
 * The checkpoint's open design choices of the YAML editor, each a live
 * `?variant=` value in the browser on the mock backend; a choice not asked
 * for takes the first of its values. They go once the owner has chosen.
 */
export interface Variants {
  /** Where the diff of an apply shows: its own tab beside the YAML, or the YAML tab turning into it. */
  readonly diff: "tab" | "inplace";
  /** Where the table of conflicts shows: a bar above the editor, or the place of the diff. */
  readonly conflicts: "bar" | "diff";
  /** Where "changed on server" shows: a bar over the editor, or a marker in the tab. */
  readonly changed: "bar" | "marker";
}

const CHOICES = {
  diff: ["tab", "inplace"],
  conflicts: ["bar", "diff"],
  changed: ["bar", "marker"],
} as const;

/**
 * `?variant=diff-inplace,conflicts-diff,changed-marker`, the values comma
 * separated or as several `variant` parameters.
 */
export function readVariants(search: string): Variants {
  const asked = new URLSearchParams(search)
    .getAll("variant")
    .flatMap((value) => value.split(","));
  const pick = <K extends keyof Variants>(name: K): Variants[K] =>
    (CHOICES[name].find((value) => asked.includes(`${name}-${value}`)) ??
      CHOICES[name][0]) as Variants[K];
  return {
    diff: pick("diff"),
    conflicts: pick("conflicts"),
    changed: pick("changed"),
  };
}

let current: Variants | undefined;

export function variants(): Variants {
  current ??= readVariants(globalThis.location.search);
  return current;
}
