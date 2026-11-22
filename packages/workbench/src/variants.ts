// @todo: remove the variants the owner did not choose once he has chosen at the checkpoint

/**
 * The live variants of how errors show, chosen by `?variant=` in the mock's
 * URL: `?variant=code:inline,status:code`. A group the URL does not name
 * takes its first variant, the recommended one.
 */
const VARIANTS = {
  /** How an error's code shows: under the message, before it, or only in Copy details. */
  code: ["line", "inline", "copy"],
  /** The status bar's word for an error: by the code's family, or the code. */
  status: ["family", "code"],
  /** A waiting list's cause: said in the status bar and the skeleton, or only in the tooltip. */
  wait: ["inline", "tooltip"],
  /** The kubeconfig files that fail in the space picker: a group of their own, or a line at its end. */
  kubeconfig: ["group", "footer"],
  /** Whether a newly failing kubeconfig file raises a toast once. */
  toast: ["once", "none"],
} as const;

export type VariantGroup = keyof typeof VARIANTS;

export type Variant<G extends VariantGroup> = (typeof VARIANTS)[G][number];

export function variant<G extends VariantGroup>(group: G): Variant<G> {
  const named = new URLSearchParams(location.search)
    .getAll("variant")
    .flatMap((value) => value.split(","));
  const chosen = VARIANTS[group].find((name) =>
    named.includes(`${group}:${name}`),
  );
  return chosen ?? VARIANTS[group][0];
}
