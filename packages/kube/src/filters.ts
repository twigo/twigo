import { Changes } from "@twigo/workbench";
import type { Health } from "./health";

/**
 * What each open list editor filters its rows by, by URI: a text and a
 * health. It also carries the asks for a filter field's focus.
 */
export class ListFilters {
  readonly changes = new Changes();
  readonly #texts = new Map<string, string>();
  readonly #health = new Map<string, Health>();
  readonly #focus = new Map<string, number>();

  text(uri: string): string | undefined {
    return this.#texts.get(uri);
  }

  setText(uri: string, text: string): void {
    this.#texts.set(uri, text);
    this.changes.emit();
  }

  health(uri: string): Health | undefined {
    return this.#health.get(uri);
  }

  /** Undefined shows every row. */
  setHealth(uri: string, health: Health | undefined): void {
    if (health) this.#health.set(uri, health);
    else this.#health.delete(uri);
    this.changes.emit();
  }

  /** Asks the list's filter field to take the focus; each ask is a new number. */
  focus(uri: string): void {
    this.#focus.set(uri, (this.#focus.get(uri) ?? 0) + 1);
    this.changes.emit();
  }

  focusRequest(uri: string): number {
    return this.#focus.get(uri) ?? 0;
  }
}
