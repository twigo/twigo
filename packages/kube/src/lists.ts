import type { ListController } from "./ResourceTable";

/** What list commands do to the list or tree that has the focus. */
export interface ListCommands extends ListController {
  /** List editors only. */
  closeDetails?(): void;
  /** Trees only. */
  collapse?(): void;
  expand?(): void;
}

/** The mounted lists and trees by element, so commands act on the one that has the focus. */
export class Lists {
  readonly #lists = new WeakMap<Element, ListCommands>();

  register(element: Element, list: ListCommands): () => void {
    this.#lists.set(element, list);
    return () => {
      this.#lists.delete(element);
    };
  }

  focused(): ListCommands | undefined {
    for (let at = document.activeElement; at; at = at.parentElement) {
      const list = this.#lists.get(at);
      if (list) return list;
    }
    return undefined;
  }
}
