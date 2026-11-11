import type { Mode, ProxyWhy, TerminalKind } from "@twigo/protocol";

/** What a terminal's tab says of how it reaches clusters (ARCHITECTURE 4.6). */
export interface KindWords {
  readonly credentials: "own" | "proxy";
  /** In a chip: `Proxy · guarded`. */
  readonly short: string;
  /** What the person gets, and why. */
  readonly why: string;
  /** Set while a terminal with real credentials holds them on a context that is not read-write any more. */
  readonly warning:
    { readonly title: string; readonly detail: string } | undefined;
}

const PROXY =
  "Through Twigo's proxy, which follows each context's mode: a write from a guarded context asks first, and a read-only one is refused.";

function reason(why: ProxyWhy, context: string): string {
  switch (why) {
    case "mode":
      return `${context} was not read-write when this terminal started.`;
    case "provider":
      return `${context} comes from a provider, so it has no kubeconfig entry to point at.`;
    case "policyFile":
      return `Your administrator's policy file sends ${context} through the proxy.`;
  }
}

/** `mode` is the terminal's context's now, if the catalog lists it. */
export function describeKind(
  kind: TerminalKind,
  context: string,
  mode: Mode | undefined,
): KindWords {
  if (kind.kind === "proxy") {
    return {
      credentials: "proxy",
      short: mode === undefined ? "Proxy" : `Proxy · ${mode}`,
      why: `${PROXY} ${reason(kind.why, context)}`,
      warning: undefined,
    };
  }
  const why =
    "With your own credentials: every context in your kubeconfig is in reach, as in any terminal app.";
  if (mode === undefined || mode === "read-write") {
    return {
      credentials: "own",
      short: "Your credentials",
      why,
      warning: undefined,
    };
  }
  return {
    credentials: "own",
    short: `Your credentials · ${mode} context`,
    why,
    warning: {
      title: `Holds your real credentials, and ${context} is ${mode} now.`,
      detail:
        "It still reaches every context in your kubeconfig. Restart goes through Twigo's proxy.",
    },
  };
}
