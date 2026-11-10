import * as v from "valibot";
import type { ContextColor, Environment, Space } from "@twigo/protocol";
import { Changes } from "../changes";
import type { StateStore } from "../state/store";
import type { Catalog } from "./catalog";

const KEY = "contexts/colors";

export const CONTEXT_COLORS: readonly ContextColor[] = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
];

/**
 * The colours a context gets by its name. Red stays out, for the user to
 * give or an environment type to set (ARCHITECTURE 4.2, 6.4), and yellow,
 * which reads as a warning.
 */
const AUTOMATIC: readonly ContextColor[] = [
  "blue",
  "purple",
  "green",
  "orange",
];

const CHOSEN = v.record(v.string(), v.picklist(CONTEXT_COLORS));

/** The colour an environment type gives a context (ARCHITECTURE 6.4). */
const OF_ENVIRONMENT: Readonly<Record<Environment, ContextColor>> = {
  production: "red",
  staging: "orange",
  development: "green",
  local: "blue",
};

export function contextAccent(color: ContextColor): string {
  return `var(--context-${color})`;
}

/** Where a context's colour comes from, strongest first. */
export type ColorSource = "kubeconfig" | "chosen" | "environment" | "automatic";

/**
 * Every context's colour (ARCHITECTURE 4.2): the one its kubeconfig's
 * `twigo` extension gives, else the one the user chose in Twigo, kept in
 * the app's state, else its environment type's, else one picked from its
 * name, the same each time.
 */
export class ContextColors {
  readonly changes = new Changes();
  #chosen: Readonly<Record<string, ContextColor>>;

  constructor(
    private readonly catalog: Catalog,
    private readonly state: StateStore,
  ) {
    this.#chosen = state.get(null, KEY, CHOSEN, {});
    catalog.changes.subscribe(() => {
      this.changes.emit();
    });
  }

  of(context: string): ContextColor {
    return (
      this.catalog.find(context)?.color ??
      this.#chosen[context] ??
      this.#ofEnvironment(context) ??
      automatic(context)
    );
  }

  #ofEnvironment(context: string): ContextColor | undefined {
    const environment = this.catalog.find(context)?.access.environment;
    return environment ? OF_ENVIRONMENT[environment] : undefined;
  }

  source(context: string): ColorSource {
    if (this.catalog.find(context)?.color) return "kubeconfig";
    if (this.#chosen[context]) return "chosen";
    return this.#ofEnvironment(context) ? "environment" : "automatic";
  }

  /** Undefined goes back to its environment type's colour, else its name's. */
  choose(context: string, color: ContextColor | undefined): void {
    const { [context]: _, ...rest } = this.#chosen;
    this.#chosen = color === undefined ? rest : { ...rest, [context]: color };
    this.state.set(null, KEY, this.#chosen);
    this.changes.emit();
  }

  /** A space with one context takes its colour; one with several, none. */
  ofSpace(space: Space): ContextColor | undefined {
    const [only, ...more] = space.contexts;
    return only === undefined || more.length > 0 ? undefined : this.of(only);
  }
}

/** FNV-1a over the name, so a context keeps its colour across starts and machines. */
function automatic(name: string): ContextColor {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return AUTOMATIC[(hash >>> 0) % AUTOMATIC.length] ?? "blue";
}
