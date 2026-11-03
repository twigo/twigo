import type { Sort } from "@twigo/protocol";
import { Changes } from "@twigo/workbench";
import type { Health } from "./columns";
import type { ObjectTab } from "./object/tabs";

/** A picked health and the status column's values it stands for. */
export interface HealthChoice {
  readonly health: Health;
  /** As derived from the list's counts once it had them; none until then. */
  readonly values: readonly string[] | undefined;
}

interface State {
  readonly sort?: Sort;
  readonly text?: string;
  /** Null when the user showed every row over the health in the URI. */
  readonly health?: HealthChoice | null;
  readonly collapsed: ReadonlySet<string>;
  /** Each ask for the filter field's focus is a new number. */
  readonly focus: number;
  /** The view the row's details show, kept as the selection moves. */
  readonly details: ObjectTab;
}

const INITIAL: State = { collapsed: new Set(), focus: 0, details: "overview" };

/**
 * What each open list editor shows, by URI (ARCHITECTURE 4.4): its sort,
 * its text filter, its picked health, its collapsed groups, and the asks
 * for its filter field's focus, and the view its details show, so an
 * editor that mounts again shows the same.
 */
export class ListStates {
  readonly changes = new Changes();
  readonly #lists = new Map<string, State>();

  #get(uri: string): State {
    return this.#lists.get(uri) ?? INITIAL;
  }

  #update(uri: string, change: Partial<State>): void {
    this.#lists.set(uri, { ...this.#get(uri), ...change });
    this.changes.emit();
  }

  /** Undefined sorts by Name. */
  sort(uri: string): Sort | undefined {
    return this.#get(uri).sort;
  }

  setSort(uri: string, sort: Sort): void {
    this.#update(uri, { sort });
  }

  text(uri: string): string | undefined {
    return this.#get(uri).text;
  }

  setText(uri: string, text: string): void {
    this.#update(uri, { text });
  }

  /** Undefined until the user picked; then null for every row. */
  health(uri: string): HealthChoice | null | undefined {
    return this.#get(uri).health;
  }

  /** Null shows every row, whatever health the list's URI names. */
  setHealth(uri: string, choice: HealthChoice | null): void {
    const current = this.#get(uri).health;
    if (
      current?.health === choice?.health &&
      current?.values?.join("\n") === choice?.values?.join("\n")
    )
      return;
    this.#update(uri, { health: choice });
  }

  collapsed(uri: string): ReadonlySet<string> {
    return this.#get(uri).collapsed;
  }

  toggleGroup(uri: string, value: string): void {
    const collapsed = new Set(this.#get(uri).collapsed);
    if (!collapsed.delete(value)) collapsed.add(value);
    this.#update(uri, { collapsed });
  }

  detailsTab(uri: string): ObjectTab {
    return this.#get(uri).details;
  }

  setDetailsTab(uri: string, details: ObjectTab): void {
    if (this.#get(uri).details !== details) this.#update(uri, { details });
  }

  /** Asks the list's filter field to take the focus. */
  focus(uri: string): void {
    this.#update(uri, { focus: this.#get(uri).focus + 1 });
  }

  focusRequest(uri: string): number {
    return this.#get(uri).focus;
  }
}
