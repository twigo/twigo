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
  /** The filter field was asked to take the focus and has not yet. */
  readonly focus: boolean;
  /** The view the row's details show, kept as the selection moves. */
  readonly details: ObjectTab;
  /** Whether the details are open, as the list's editor last showed them. */
  readonly detailsOpen: boolean;
  /** The width the details beside the list take from it, in px; 0 without them. */
  readonly inspector: number;
  /** The width the list keeps for its group's strip, in px; 0 until the strip's actions have shown their last stage. */
  readonly stripMin: number;
  /** By health, and `all`, the most characters its count had while the text was empty. */
  readonly countDigits: Readonly<Record<string, number>>;
}

const INITIAL: State = {
  collapsed: new Set(),
  focus: false,
  details: "overview",
  detailsOpen: false,
  inspector: 0,
  stripMin: 0,
  countDigits: {},
};

/**
 * What each open list editor shows, by URI (ARCHITECTURE 4.4): its sort,
 * its text filter, its picked health, its collapsed groups, the asks for
 * its filter field's focus and the view its details show, so an editor that
 * mounts again shows the same. A list that closes opens again with the text
 * and health of its URI (4.4). The room its details take from it is 0 once
 * the editor unmounts, and the width its strip needs stays as its actions
 * last measured it, as does the room its health counts keep. Whether its
 * details are open is the editor's to publish, for the list that takes its
 * place, and goes with it.
 */
export class ListStates {
  readonly changes = new Changes();
  /** The strip's measures, which only the strip and a list beside its details read. */
  readonly strip = new Changes();
  readonly #lists = new Map<string, State>();

  #get(uri: string): State {
    return this.#lists.get(uri) ?? INITIAL;
  }

  #update(uri: string, change: Partial<State>): void {
    this.#lists.set(uri, { ...this.#get(uri), ...change });
    this.changes.emit();
  }

  #measure(uri: string, change: Partial<State>): void {
    this.#lists.set(uri, { ...this.#get(uri), ...change });
    this.strip.emit();
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

  detailsOpen(uri: string): boolean {
    return this.#get(uri).detailsOpen;
  }

  setDetailsOpen(uri: string, detailsOpen: boolean): void {
    if (this.#get(uri).detailsOpen !== detailsOpen)
      this.#update(uri, { detailsOpen });
  }

  inspector(uri: string): number {
    return this.#get(uri).inspector;
  }

  setInspector(uri: string, inspector: number): void {
    if (this.#get(uri).inspector !== inspector)
      this.#measure(uri, { inspector });
  }

  stripMin(uri: string): number {
    return this.#get(uri).stripMin;
  }

  setStripMin(uri: string, stripMin: number): void {
    if (this.#get(uri).stripMin !== stripMin) this.#measure(uri, { stripMin });
  }

  countDigits(uri: string): Readonly<Record<string, number>> {
    return this.#get(uri).countDigits;
  }

  /** The digits of counts read while the text was empty: what each count keeps room for grows, never shrinks. */
  seeCountDigits(uri: string, digits: Readonly<Record<string, number>>): void {
    const kept = this.#get(uri).countDigits;
    const wider = Object.entries(digits).filter(
      ([key, count]) => count > (kept[key] ?? 0),
    );
    if (wider.length > 0)
      this.#measure(uri, {
        countDigits: { ...kept, ...Object.fromEntries(wider) },
      });
  }

  /**
   * What the list `to` that takes `from`'s place keeps of it: how it is
   * sorted, its collapsed groups, and the details, open or not, in the view
   * they show. Its text and health come with its URI.
   */
  carry(from: string, to: string): void {
    const { sort, collapsed, details, detailsOpen } = this.#get(from);
    this.#update(to, {
      ...(sort && { sort }),
      collapsed,
      details,
      detailsOpen,
    });
  }

  /** The list's editor closed: the text and health picked in it go. */
  closed(uri: string): void {
    const state = this.#lists.get(uri);
    if (!state) return;
    const { text, health, ...kept } = state;
    if (text === undefined && health === undefined) return;
    this.#lists.set(uri, kept);
    this.changes.emit();
  }

  /** Asks the list's filter field to take the focus. */
  focus(uri: string): void {
    this.#update(uri, { focus: true });
  }

  wantsFocus(uri: string): boolean {
    return this.#get(uri).focus;
  }

  /** The filter field took the focus it was asked to take. */
  focused(uri: string): void {
    if (this.#get(uri).focus) this.#update(uri, { focus: false });
  }
}
