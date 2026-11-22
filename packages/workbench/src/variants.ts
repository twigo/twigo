/**
 * The variants of the Helm views that the owner chooses among on the mock
 * (`?variant=helm:explorer,tabs:four,mask:token`, any of them, comma
 * separated); the first of each family is the one recommended, and the
 * default.
 *
 * @todo: remove the variants the owner did not choose once he has chosen at the checkpoint
 */
export interface Variants {
  /** Where the releases' list lives. */
  readonly helm: "explorer" | "sidebar" | "view";
  /** The release editor's views. */
  readonly tabs: "four" | "split" | "page";
  /** How a masked value looks. */
  readonly mask: "token" | "pill" | "tree";
}

const DEFAULTS: Variants = { helm: "explorer", tabs: "four", mask: "token" };

const FAMILIES: { readonly [F in keyof Variants]: readonly Variants[F][] } = {
  helm: ["explorer", "sidebar", "view"],
  tabs: ["four", "split", "page"],
  mask: ["token", "pill", "tree"],
};

/** @todo: remove the variants the owner did not choose once he has chosen at the checkpoint */
export function variants(
  search: string = globalThis.location.search,
): Variants {
  const asked = new Set(
    (new URLSearchParams(search).get("variant") ?? "").split(","),
  );
  const pick = <F extends keyof Variants>(family: F): Variants[F] =>
    FAMILIES[family].find((name) => asked.has(`${family}:${name}`)) ??
    DEFAULTS[family];
  return { helm: pick("helm"), tabs: pick("tabs"), mask: pick("mask") };
}
