import type { Resource } from "@twigo/protocol";
import { HELM_RELEASES } from "@twigo/protocol";

/**
 * Helm's release statuses
 * ([`common/status.go`](https://github.com/helm/helm/blob/v4.3.2/pkg/release/common/status.go#L25-L41)):
 * what a list and a history draw of each. `deployed` is the healthy word, which
 * recedes; `superseded` and `uninstalled` say a revision is not the one that
 * runs, in the quiet role; `failed` fails; the `pending-*` statuses and
 * `uninstalling` wait, with a pulsing dot; `unknown`, and a word Helm does not
 * know, is a warning.
 */
const WORDS: Readonly<
  Record<string, { tone?: "warn" | "error"; quiet?: true }>
> = {
  deployed: {},
  superseded: { quiet: true },
  uninstalled: { quiet: true },
  failed: { tone: "error" },
  unknown: { tone: "warn" },
  uninstalling: { tone: "warn" },
  "pending-install": { tone: "warn" },
  "pending-upgrade": { tone: "warn" },
  "pending-rollback": { tone: "warn" },
};

/** The tone of an abnormal status, none for a healthy one. */
export function statusTone(word: string): "warn" | "error" | undefined {
  return (WORDS[word] ?? { tone: "warn" }).tone;
}

/** A revision that Helm no longer runs: its status reads in the quiet role. */
export function isQuiet(word: string): boolean {
  return WORDS[word]?.quiet === true;
}

/** The statuses that wait for Helm to end, whose dot pulses. */
export const IN_FLIGHT_RELEASE =
  /^(uninstalling|pending-install|pending-upgrade|pending-rollback)$/;

/** What a row says in place of its status when its latest revision cannot be read, by the code the core carries in its Problem. */
export const PROBLEMS: Readonly<
  Record<string, { readonly word: string; readonly why: string }>
> = {
  "helm.not-a-release": {
    word: "Unreadable",
    why: "Its Secret is not a Helm release.",
  },
  "helm.truncated": {
    word: "Truncated",
    why: "Its Secret ends early, so its release cannot be read.",
  },
  "helm.too-large": {
    word: "Too large",
    why: "Its release is larger than Twigo reads.",
  },
  "internal.panic": {
    word: "Unreadable",
    why: "Twigo stopped while it read this release.",
  },
};

export function problemWords(code: string): {
  readonly word: string;
  readonly why: string;
} {
  return (
    PROBLEMS[code] ?? {
      word: "Unreadable",
      why: "Twigo could not read this release.",
    }
  );
}

/** What a list of releases stands in for beside discovery's resources: namespaced, with no verbs or subresources of its own. */
export const HELM_RESOURCE: Resource = {
  gvr: HELM_RELEASES,
  kind: "HelmRelease",
  singular: "release",
  shortNames: ["helm"],
  namespaced: true,
  subresources: [],
};
