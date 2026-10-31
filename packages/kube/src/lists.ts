import type { ListController } from "./ResourceTable";

/** The mounted tables by grid element, so commands act on the one that has the focus. */
export class Lists {
  readonly #lists = new WeakMap<Element, ListController>();

  register(grid: Element, list: ListController): () => void {
    this.#lists.set(grid, list);
    return () => {
      this.#lists.delete(grid);
    };
  }

  focused(): ListController | undefined {
    for (let at = document.activeElement; at; at = at.parentElement) {
      const list = this.#lists.get(at);
      if (list) return list;
    }
    return undefined;
  }
}
