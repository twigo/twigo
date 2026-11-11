import type { KubeconfigNames, KubeconfigOffer } from "@twigo/protocol";

export interface OfferName {
  readonly name: string;
  readonly kinds: string;
  readonly leftOut: boolean;
}

export interface OfferWords {
  readonly title: string;
  readonly names: readonly OfferName[];
  readonly more: string | undefined;
  readonly all: readonly OfferName[];
  readonly reason: string | undefined;
  readonly move: string;
}

const SECTIONS: readonly {
  readonly section: keyof KubeconfigNames;
  readonly noun: string;
}[] = [
  { section: "contexts", noun: "context" },
  { section: "clusters", noun: "cluster" },
  { section: "users", noun: "user" },
];

const SHOWN = 4;

const REASON =
  "Left out: your files have that name already, or what the context names is another entry there or missing, and does not move with it.";

const count = (n: number, noun: string) =>
  n === 1 ? `a ${noun}` : `${String(n)} ${noun}s`;

/** `a, b and c`. */
function joined(parts: readonly string[]): string {
  const last = parts[parts.length - 1];
  return parts.length < 2
    ? (last ?? "")
    : `${parts.slice(0, -1).join(", ")} and ${last ?? ""}`;
}

function nameLines(offer: KubeconfigOffer): OfferName[] {
  const names = [...new Set(SECTIONS.flatMap(({ section }) => offer[section]))];
  return names.map((name) => {
    const kinds = (leftOut: boolean) =>
      SECTIONS.filter(
        ({ section }) =>
          offer[section].includes(name) &&
          offer.leftOut[section].includes(name) === leftOut,
      ).map(({ noun }) => noun);
    const writes = kinds(false);
    const leaves = kinds(true);
    return {
      name,
      kinds: [
        ...(writes.length > 0 ? [writes.join(", ")] : []),
        ...(leaves.length > 0 ? [`${leaves.join(", ")} left out`] : []),
      ].join(" · "),
      leftOut: leaves.length > 0,
    };
  });
}

export function describeOffer(offer: KubeconfigOffer): OfferWords {
  const came = SECTIONS.filter(({ section }) => offer[section].length > 0).map(
    ({ section, noun }) => count(offer[section].length, noun),
  );
  const all = nameLines(offer);
  return {
    title: `${offer.terminal} in ${offer.context} added ${joined(came)} to its own kubeconfig.`,
    names: all.slice(0, SHOWN),
    more:
      all.length > SHOWN ? `and ${String(all.length - SHOWN)} more` : undefined,
    all,
    reason: all.some(({ leftOut }) => leftOut) ? REASON : undefined,
    move: `Move to ${offer.target}`,
  };
}

export function nameParts(name: string): string[] {
  return name.split(/(?<=[:/])/);
}
