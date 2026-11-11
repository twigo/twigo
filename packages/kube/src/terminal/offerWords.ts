import type { KubeconfigOffer } from "@twigo/protocol";

/** One name that came, with the kinds of entry that carry it: EKS names a context, a cluster and a user alike. */
export interface OfferEntry {
  readonly name: string;
  readonly kinds: readonly string[];
}

export interface OfferWords {
  readonly title: string;
  /** What a move writes. */
  readonly moves: readonly OfferEntry[];
  /** What a move leaves out, since the person's files hold the name already. */
  readonly leaves: readonly OfferEntry[];
  readonly move: string;
}

const count = (n: number, noun: string) =>
  n === 1 ? `a ${noun}` : `${String(n)} ${noun}s`;

/** `a, b and c`. */
function joined(parts: readonly string[]): string {
  const last = parts[parts.length - 1];
  return parts.length < 2
    ? (last ?? "")
    : `${parts.slice(0, -1).join(", ")} and ${last ?? ""}`;
}

export function describeOffer(offer: KubeconfigOffer): OfferWords {
  const lists: readonly (readonly [string, readonly string[]])[] = [
    ["context", offer.contexts],
    ["cluster", offer.clusters],
    ["user", offer.users],
  ];
  const kinds = new Map<string, string[]>();
  for (const [kind, names] of lists) {
    for (const name of names)
      kinds.set(name, [...(kinds.get(name) ?? []), kind]);
  }
  const entries = [...kinds].map(([name, of]) => ({ name, kinds: of }));
  const came = lists
    .filter(([, names]) => names.length > 0)
    .map(([kind, names]) => count(names.length, kind));
  return {
    title: `${offer.terminal} added ${joined(came)} to its own kubeconfig.`,
    moves: entries.filter(({ name }) => !offer.taken.includes(name)),
    leaves: entries.filter(({ name }) => offer.taken.includes(name)),
    move: `Move to ${offer.target}`,
  };
}
