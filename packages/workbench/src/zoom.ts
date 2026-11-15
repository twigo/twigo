import * as v from "valibot";
import { Changes } from "./changes";
import type { StateStore } from "./state/store";

const KEY = "window/zoom";

const MIN = 0.5;
const MAX = 2;
const STEP = 0.1;
const DEFAULT = 1;

const FACTOR = v.pipe(v.number(), v.minValue(MIN), v.maxValue(MAX));

/**
 * The interface zoom: the app's, not a space's, kept in the app's state and
 * read once at start. The workbench holds the factor and announces its
 * changes; the host applies it, since only the host reaches the webview
 * (ARCHITECTURE 2.3).
 */
export class Zoom {
  readonly changes = new Changes();
  #factor: number;

  constructor(private readonly state: StateStore) {
    this.#factor = state.get(null, KEY, FACTOR, DEFAULT);
  }

  get factor(): number {
    return this.#factor;
  }

  zoomIn(): void {
    this.#set(this.#factor + STEP);
  }

  zoomOut(): void {
    this.#set(this.#factor - STEP);
  }

  reset(): void {
    this.#set(DEFAULT);
  }

  #set(factor: number): void {
    const next = Math.min(MAX, Math.max(MIN, Math.round(factor * 10) / 10));
    if (next === this.#factor) return;
    this.#factor = next;
    this.state.set(null, KEY, next);
    this.changes.emit();
  }
}
