import { useEffect } from "react";
import type { MetricsState, ShownUsage } from "@twigo/protocol";

/**
 * What each space's Metrics API last said of an open object's usage, for the
 * session, so the next object of the space draws a refusal's sentence at
 * once instead of the empty meters that wait for it.
 */
export class UsageSaid {
  readonly #said = new Map<string, MetricsState>();

  get(space: string): MetricsState | undefined {
    return this.#said.get(space);
  }

  say(space: string, state: MetricsState): void {
    this.#said.set(space, state);
  }
}

/**
 * The usage an Overview draws (ARCHITECTURE 4.3): what the core sent, but a
 * usage that waits for its first answer draws the sentence the space's API
 * last gave where that was a refusal, since the answer will say it again.
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
  const state = space === undefined ? undefined : said.get(space);
  if (usage?.waiting && (state === "unavailable" || state === "forbidden")) {
    return { ...usage, state, waiting: false, containers: [] };
  }
  return usage;
}
