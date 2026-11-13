import { useEffect } from "react";
import type { MetricsState, Resource, ShownUsage } from "@twigo/protocol";
import type { Discovery, Loaded } from "../discovery";

/**
 * Whether each space's Metrics API refused the person, for the next object of
 * the space, as long as the discovery it said so under stands: a new
 * `Discovered` for the space, which `Discovery` stores as a new object, is
 * another cluster or an API installed, removed or back, and forgets it. A
 * grant of RBAC changes no discovery, so it is not seen (TODO.md).
 */
export class UsageSaid {
  readonly #refused = new Map<string, Loaded<readonly Resource[]>>();

  constructor(private readonly discovery: Pick<Discovery, "last">) {}

  refused(space: string): boolean {
    const under = this.discovery.last(space);
    return under !== undefined && this.#refused.get(space) === under;
  }

  say(space: string, state: MetricsState): void {
    const under = this.discovery.last(space);
    if (state === "forbidden" && under !== undefined) {
      this.#refused.set(space, under);
    } else {
      this.#refused.delete(space);
    }
  }
}

/**
 * The usage an Overview draws (ARCHITECTURE 4.3): what the core sent, but a
 * usage that waits for its first answer draws the refusal's sentence where
 * the space's API refused the person, since the answer will say it again.
 */
export function useDrawnUsage(
  said: UsageSaid,
  space: string | undefined,
  usage: ShownUsage | undefined,
): ShownUsage | undefined {
  useEffect(() => {
    if (space !== undefined && usage !== undefined && !usage.waiting) {
      said.say(space, usage.state);
    }
  }, [said, space, usage]);
  if (usage?.waiting && space !== undefined && said.refused(space)) {
    return { ...usage, state: "forbidden", waiting: false, containers: [] };
  }
  return usage;
}
