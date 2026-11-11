import type { KubeconfigNames, KubeconfigOffer } from "@twigo/protocol";

export interface OfferSection {
  readonly label: string;
  readonly names: readonly string[];
  readonly reason?: string;
}

export interface OfferWords {
  readonly title: string;
  readonly moves: readonly OfferSection[];
  readonly leaves: readonly OfferSection[];
  readonly move: string;
}

const SECTIONS: readonly {
  readonly section: keyof KubeconfigNames;
  readonly noun: string;
  readonly label: string;
}[] = [
  { section: "contexts", noun: "context", label: "Contexts" },
  { section: "clusters", noun: "cluster", label: "Clusters" },
  { section: "users", noun: "user", label: "Users" },
];

const count = (n: number, noun: string) =>
  n === 1 ? `a ${noun}` : `${String(n)} ${noun}s`;

/** `a, b and c`. */
function joined(parts: readonly string[]): string {
  const last = parts[parts.length - 1];
  return parts.length < 2
    ? (last ?? "")
    : `${parts.slice(0, -1).join(", ")} and ${last ?? ""}`;
}

/** The offer names no reason per name, so a section says what the core's rule (ARCHITECTURE 4.6) may have left its names out for. */
function reason(
  section: keyof KubeconfigNames,
  noun: string,
  leftOut: KubeconfigNames,
): string {
  if (section === "contexts") {
    return "Your files have a context of that name, or the cluster or user it names is another one in your files, or your files lack it and it does not move with the context.";
  }
  const named =
    leftOut.contexts.length > 0 ? ", or only contexts left out name it" : "";
  return `Your files have a ${noun} of that name${named}.`;
}

export function describeOffer(offer: KubeconfigOffer): OfferWords {
  const came = SECTIONS.filter(({ section }) => offer[section].length > 0).map(
    ({ section, noun }) => count(offer[section].length, noun),
  );
  const moves = SECTIONS.flatMap(({ section, label }) => {
    const names = offer[section].filter(
      (name) => !offer.leftOut[section].includes(name),
    );
    return names.length > 0 ? [{ label, names }] : [];
  });
  const leaves = SECTIONS.flatMap(({ section, noun, label }) => {
    const names = offer.leftOut[section];
    return names.length > 0
      ? [{ label, names, reason: reason(section, noun, offer.leftOut) }]
      : [];
  });
  return {
    title: `${offer.terminal} in ${offer.context} added ${joined(came)} to its own kubeconfig.`,
    moves,
    leaves,
    move: `Move to ${offer.target}`,
  };
}
