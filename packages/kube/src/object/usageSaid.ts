import type { MetricsState } from "@twigo/protocol";

/**
 * What each space's Metrics API last said of an open object's usage, for the
 * session, so the next object of the space draws the sentence of a refusal
 * at once, and nothing after the API went.
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
