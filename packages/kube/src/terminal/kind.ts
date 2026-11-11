import type { Mode, ProxyWhy, TerminalKind } from "@twigo/protocol";

export interface KindWarning {
  readonly title: string;
  readonly detail: string;
}

/** What a terminal's tab says of how it reaches clusters (ARCHITECTURE 4.6). */
export interface KindWords {
  readonly credentials: "own" | "proxy";
  /** In a chip: `Proxy · guarded`. */
  readonly short: string;
  /** What the person gets, and why. */
  readonly why: string;
  /** What the person should know beyond that, which turns the chip to the warning's tone. */
  readonly warnings: readonly KindWarning[];
  /** Whether Restart answers a warning: real credentials held on a context that is not read-write now. */
  readonly restartable: boolean;
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

function directWarning(direct: readonly [string, ...string[]]): KindWarning {
  const [only] = direct;
  const again =
    "Everything else here still goes through Twigo's proxy, and kubectl config use-context back to a proxy context goes through it again.";
  return direct.length === 1
    ? {
        title: `${only} reaches its cluster with your credentials, not through the proxy.`,
        detail: `A tool wrote it into this terminal's own kubeconfig. ${again}`,
      }
    : {
        title: `${String(direct.length)} contexts reach their clusters with your credentials, not through the proxy.`,
        detail: `A tool wrote them into this terminal's own kubeconfig: ${direct.join(", ")}. ${again}`,
      };
}

/**
 * `mode` is the terminal's context's now, if the catalog lists it, and
 * `direct` the contexts of a proxy terminal's file that reach their clusters
 * with the person's credentials.
 */
export function describeKind(
  kind: TerminalKind,
  context: string,
  mode: Mode | undefined,
  direct: readonly string[],
): KindWords {
  if (kind.kind === "proxy") {
    const base = mode === undefined ? "Proxy" : `Proxy · ${mode}`;
    const why = `${PROXY} ${reason(kind.why, context)}`;
    const [first, ...rest] = direct;
    if (first === undefined) {
      return {
        credentials: "proxy",
        short: base,
        why,
        warnings: [],
        restartable: false,
      };
    }
    return {
      credentials: "proxy",
      short: `${base}, ${rest.length === 0 ? first : `${String(direct.length)} contexts`} direct`,
      why,
      warnings: [directWarning([first, ...rest])],
      restartable: false,
    };
  }
  const why =
    "With your own credentials: every context in your kubeconfig is in reach, as in any terminal app.";
  if (mode === undefined || mode === "read-write") {
    return {
      credentials: "own",
      short: "Your credentials",
      why,
      warnings: [],
      restartable: false,
    };
  }
  return {
    credentials: "own",
    short: `Your credentials · ${mode} context`,
    why,
    warnings: [
      {
        title: `Holds your real credentials, and ${context} is ${mode} now.`,
        detail:
          "It still reaches every context in your kubeconfig. Restart goes through Twigo's proxy.",
      },
    ],
    restartable: true,
  };
}
