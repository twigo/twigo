import type { Tone } from "@twigo/ui";
import { Changes } from "../changes";

export interface SpaceConnection {
  readonly tone: Tone;
  /** Says the state in words, for the tile's tooltip: `Reconnecting`. */
  readonly label: string;
  /** The version of what the space reaches, once known: `v1.33.4`. */
  readonly version?: string;
}

/** What a feature knows about a space's connection, for its rail tile. */
export interface SpaceStatusProvider {
  readonly changes: Changes;
  status(space: string): SpaceConnection | undefined;
}

/**
 * The connection of each space as features report it (ARCHITECTURE 4.2):
 * the workbench draws it on the rail without knowing what connects.
 */
export class SpaceStatus {
  readonly changes = new Changes();
  readonly #providers = new Set<SpaceStatusProvider>();

  register(provider: SpaceStatusProvider): () => void {
    this.#providers.add(provider);
    const unsubscribe = provider.changes.subscribe(() => {
      this.changes.emit();
    });
    this.changes.emit();
    return () => {
      unsubscribe();
      this.#providers.delete(provider);
      this.changes.emit();
    };
  }

  get(space: string): SpaceConnection | undefined {
    for (const provider of this.#providers) {
      const state = provider.status(space);
      if (state) return state;
    }
    return undefined;
  }
}
