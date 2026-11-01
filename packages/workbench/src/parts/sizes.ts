import * as v from "valibot";
import { Changes } from "../changes";
import type { StateStore } from "../state/store";
import type { Location } from "../views/registry";

const KEY = "parts/sizes";

const SIZE = v.fallback(
  v.optional(v.pipe(v.number(), v.gtValue(0))),
  undefined,
);

const SIZES = v.object({ sidebar: SIZE, panel: SIZE, secondary: SIZE });

type Sizes = v.InferOutput<typeof SIZES>;

/**
 * The width of each side bar and the height of the panel, once the user
 * resized them: the app's, not a space's, so switching spaces keeps the
 * layout still, as VS Code keeps sizes per profile.
 */
export class PartSizes {
  readonly changes = new Changes();
  #sizes: Sizes;

  constructor(private readonly state: StateStore) {
    this.#sizes = state.get(null, KEY, SIZES, {
      sidebar: undefined,
      panel: undefined,
      secondary: undefined,
    });
  }

  get(location: Location): number | undefined {
    return this.#sizes[location];
  }

  set(location: Location, size: number): void {
    if (this.#sizes[location] === size) return;
    this.#sizes = { ...this.#sizes, [location]: size };
    this.state.set(null, KEY, this.#sizes);
    this.changes.emit();
  }
}
