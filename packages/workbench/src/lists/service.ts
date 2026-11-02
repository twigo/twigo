import type { ListController } from "@twigo/ui";

/**
 * What a list command can reach: a widget's controller, or what the
 * element around it adds, such as a list editor's filter field.
 */
export interface ListTarget extends Partial<ListController> {
  /** Focuses the filter of the list around the focus. */
  filter?(): void;
  /** Closes what the list shows beside it, such as a row's details. */
  close?(): void;
}

type Capability = keyof ListTarget;

/**
 * The mounted lists, grids and trees by element, so the `list.*` commands
 * act on the one that has the focus, as VS Code's list service does. A
 * command takes the nearest element around the focus that can do it.
 */
export class Lists {
  readonly #targets = new WeakMap<Element, ListTarget>();

  register(element: Element, target: ListTarget): () => void {
    this.#targets.set(element, target);
    return () => {
      if (this.#targets.get(element) === target) this.#targets.delete(element);
    };
  }

  focused<K extends Capability>(
    capability: K,
  ): (ListTarget & Required<Pick<ListTarget, K>>) | undefined {
    for (let at = document.activeElement; at; at = at.parentElement) {
      const target = this.#targets.get(at);
      if (target?.[capability])
        return target as ListTarget & Required<Pick<ListTarget, K>>;
    }
    return undefined;
  }
}
