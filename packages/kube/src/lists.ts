import type { ListController } from "./ResourceTable";

/** What list commands do to the list or tree that has the focus. */
export interface ListCommands extends ListController {
  /** List editors only. */
  closeDetails?(): void;
  /** Opens or focuses the list editor's filter field. */
  filter?(): void;
  /** Trees only. */
  collapse?(): void;
  expand?(): void;
}

/**
 * The mounted lists and trees by element, so commands act on the one that
 * has the focus, and list editors by URI, for a menu that holds the focus.
 */
export class Lists {
  readonly #lists = new WeakMap<Element, ListCommands>();
  readonly #editors = new Map<string, ListCommands>();

  register(element: Element, list: ListCommands, uri?: string): () => void {
    this.#lists.set(element, list);
    if (uri !== undefined) this.#editors.set(uri, list);
    return () => {
      this.#lists.delete(element);
      if (uri !== undefined && this.#editors.get(uri) === list)
        this.#editors.delete(uri);
    };
  }

  editor(uri: string): ListCommands | undefined {
    return this.#editors.get(uri);
  }

  focused(): ListCommands | undefined {
    for (let at = document.activeElement; at; at = at.parentElement) {
      const list = this.#lists.get(at);
      if (list) return list;
    }
    return undefined;
  }
}
