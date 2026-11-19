import { useSyncExternalStore } from "react";
import { Changes } from "@twigo/workbench";

/** The context key an object's page sets to its editor's URI, so a command finds the page it was run from. */
export const OBJECT_URI = "object.uri";

/** The context key an object editor sets to the object it shows, as `resource/details` names it, so that a key or the palette acts on it. */
export const OBJECT_SUBJECT = "object.subject";

/** The context key an object's page sets while its filter holds text. */
export const OBJECT_FILTERED = "object.filtered";

/**
 * What a page's filter makes of the groups in a part of its sections, which
 * the part draws open or folded: `open` says whether the group named `id` is
 * open where, without the filter, it would be `normally`, and `set` is the
 * person opening or folding it under the filter's text. A group it
 * `narrowed` draws the rows it kept, the cluster's defaults among them.
 */
export interface GroupFolds {
  open(id: string, normally: boolean): boolean;
  set(id: string, open: boolean): void;
  narrowed(id: string): boolean;
}

/** Where a page was scrolled to: the section at the top of its viewport and how far into it. */
export interface Place {
  readonly section: string;
  readonly offset: number;
}

interface State {
  readonly text: string;
  readonly open: boolean;
  readonly focus: boolean;
  readonly match: boolean;
  /** Folded by the person while the filter holds text, which only that text keeps. */
  readonly shut: ReadonlySet<string>;
  /** Groups opened or folded by the person while the filter holds text, which only that text keeps. */
  readonly groups: ReadonlyMap<string, boolean>;
  readonly place: Place | undefined;
}

const INITIAL: State = {
  text: "",
  open: false,
  focus: false,
  match: false,
  shut: new Set(),
  groups: new Map(),
  place: undefined,
};

/**
 * What each Overview shows beyond its object, by the URI of the editor it is
 * in, the list editor's for the inspector: its filter and where it was
 * scrolled to, so that the inspector moving to another object of the kind
 * reads as the person left it.
 */
export class PageStates {
  readonly changes = new Changes();
  readonly #pages = new Map<string, State>();
  readonly #elements = new Map<string, HTMLElement>();
  readonly #focusing = new Set<string>();

  #get(uri: string): State {
    return this.#pages.get(uri) ?? INITIAL;
  }

  #update(uri: string, change: Partial<State>): void {
    this.#pages.set(uri, { ...this.#get(uri), ...change });
    this.changes.emit();
  }

  text(uri: string): string {
    return this.#get(uri).text;
  }

  /** The filter's text changes what it matches, so the sections and groups the person folded under the last text open again. */
  setText(uri: string, text: string): void {
    if (this.#get(uri).text !== text)
      this.#update(uri, { text, shut: new Set(), groups: new Map() });
  }

  shown(uri: string): boolean {
    const { open, text } = this.#get(uri);
    return open || text !== "";
  }

  openFilter(uri: string): void {
    this.#update(uri, { open: true, focus: true });
  }

  closeFilter(uri: string): void {
    if (this.#get(uri).open) this.#update(uri, { open: false });
  }

  wantsFocus(uri: string): boolean {
    return this.#get(uri).focus;
  }

  focused(uri: string): void {
    if (this.#get(uri).focus) this.#update(uri, { focus: false });
  }

  goToMatch(uri: string): void {
    this.#update(uri, { match: true });
  }

  wantsMatch(uri: string): boolean {
    return this.#get(uri).match;
  }

  matched(uri: string): void {
    if (this.#get(uri).match) this.#update(uri, { match: false });
  }

  shut(uri: string): ReadonlySet<string> {
    return this.#get(uri).shut;
  }

  setShut(uri: string, ids: readonly string[], shut: boolean): void {
    const now = new Set(this.#get(uri).shut);
    for (const id of ids) {
      if (shut) now.add(id);
      else now.delete(id);
    }
    this.#update(uri, { shut: now });
  }

  /** Whether the person opened or folded the group under the filter's text, undefined if they did not. */
  group(uri: string, id: string): boolean | undefined {
    return this.#get(uri).groups.get(id);
  }

  setGroup(uri: string, id: string, open: boolean): void {
    this.#update(uri, {
      groups: new Map(this.#get(uri).groups).set(id, open),
    });
  }

  place(uri: string): Place | undefined {
    return this.#get(uri).place;
  }

  /** Nothing draws from the place, so a scroll changing it tells no one. */
  setPlace(uri: string, place: Place | undefined): void {
    this.#pages.set(uri, { ...this.#get(uri), place });
  }

  attach(uri: string, element: HTMLElement): () => void {
    this.#elements.set(uri, element);
    if (this.#focusing.delete(uri)) element.focus();
    return () => {
      if (this.#elements.get(uri) === element) this.#elements.delete(uri);
    };
  }

  /** Gives the page the keyboard focus if it is drawn. */
  focusPage(uri: string): void {
    this.#elements.get(uri)?.focus();
  }

  /** Gives the page the keyboard focus as an editor that has just come takes it: now if the page is drawn, else once it is. */
  focusPageOnceDrawn(uri: string): void {
    const element = this.#elements.get(uri);
    if (element) element.focus();
    else this.#focusing.add(uri);
  }

  closed(uri: string): void {
    this.#focusing.delete(uri);
    if (this.#pages.delete(uri)) this.changes.emit();
  }
}

/** Whether the page's filter holds text, drawn again only when that changes and not with each key typed. */
export function useFiltered(pages: PageStates, uri: string): boolean {
  return useSyncExternalStore(
    pages.changes.subscribe,
    () => pages.text(uri) !== "",
  );
}
