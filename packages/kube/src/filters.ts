import { Changes } from "@twigo/workbench";
import type { Health } from "./health";

/** A picked health and the status column's values it stands for. */
export interface HealthChoice {
  readonly health: Health;
  /** As derived from the list's counts when it last had them. */
  readonly values: readonly string[];
}

/**
 * What each open list editor filters its rows by, by URI: a text and a
 * health. It also carries the asks for a filter field's focus.
 */
export class ListFilters {
  readonly changes = new Changes();
  readonly #texts = new Map<string, string>();
  readonly #health = new Map<string, HealthChoice>();
  readonly #focus = new Map<string, number>();

  text(uri: string): string | undefined {
    return this.#texts.get(uri);
  }

  setText(uri: string, text: string): void {
    this.#texts.set(uri, text);
    this.changes.emit();
  }

  health(uri: string): HealthChoice | undefined {
    return this.#health.get(uri);
  }

  /** Undefined shows every row. */
  setHealth(uri: string, choice: HealthChoice | undefined): void {
    const current = this.#health.get(uri);
    if (
      current?.health === choice?.health &&
      current?.values.join("\n") === choice?.values.join("\n")
    )
      return;
    if (choice) this.#health.set(uri, choice);
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
