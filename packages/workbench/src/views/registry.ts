import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import { Changes } from "../changes";
import {
  evaluate,
  parseWhen,
  type Lookup,
  type When,
} from "../contextkey/when";

/** Where a view container sits (ARCHITECTURE 4.1). */
export type Location = "sidebar" | "panel" | "secondary";

export const LOCATIONS: readonly Location[] = ["sidebar", "panel", "secondary"];

export const LOCATION_TITLES: Readonly<Record<Location, string>> = {
  sidebar: "Primary Side Bar",
  panel: "Panel",
  secondary: "Secondary Side Bar",
};

export interface ViewContainer {
  readonly id: string;
  readonly title: string;
  readonly icon: LucideIcon;
  readonly location: Location;
  readonly order?: number;
}

/** A view: a descriptor, so the user can move it to another container. */
export interface View {
  readonly id: string;
  readonly title: string;
  readonly container: string;
  readonly when?: string;
  readonly order?: number;
  readonly component: ComponentType;
}

export type Alignment = "left" | "right";

export interface StatusBarItem {
  readonly id: string;
  readonly alignment: Alignment;
  /** Higher sits further out: leftmost on the left, rightmost on the right. */
  readonly priority: number;
  readonly when?: string;
  readonly component: ComponentType;
}

interface Conditional<T> {
  readonly item: T;
  readonly when: When | undefined;
}

/** The view containers, views and status-bar items that features contribute. */
export class Views {
  readonly changes = new Changes();
  readonly #containers = new Map<string, ViewContainer>();
  readonly #views = new Map<string, Conditional<View>>();
  readonly #items = new Map<string, Conditional<StatusBarItem>>();

  registerContainer(container: ViewContainer): () => void {
    return this.#add(this.#containers, container.id, container);
  }

  registerView(view: View): () => void {
    return this.#add(this.#views, view.id, conditional(view));
  }

  registerStatusBarItem(item: StatusBarItem): () => void {
    return this.#add(this.#items, item.id, conditional(item));
  }

  containers(location: Location): ViewContainer[] {
    return [...this.#containers.values()]
      .filter((container) => container.location === location)
      .sort(byOrder);
  }

  container(id: string): ViewContainer | undefined {
    return this.#containers.get(id);
  }

  view(id: string): View | undefined {
    return this.#views.get(id)?.item;
  }

  allViews(): View[] {
    return [...this.#views.values()].map(({ item }) => item);
  }

  /**
   * The views shown in a container: those placed there by the user, else by
   * their descriptor, whose `when` holds.
   */
  viewsIn(
    container: string,
    placement: Readonly<Record<string, string>>,
    lookup: Lookup,
  ): View[] {
    return [...this.#views.values()]
      .filter(
        ({ item }) => (placement[item.id] ?? item.container) === container,
      )
      .filter(({ when }) => !when || evaluate(when, lookup))
      .map(({ item }) => item)
      .sort(byOrder);
  }

  statusBarItems(alignment: Alignment, lookup: Lookup): StatusBarItem[] {
    return [...this.#items.values()]
      .filter(({ item }) => item.alignment === alignment)
      .filter(({ when }) => !when || evaluate(when, lookup))
      .map(({ item }) => item)
      .sort((a, b) =>
        alignment === "left"
          ? b.priority - a.priority
          : a.priority - b.priority,
      );
  }

  #add<T>(map: Map<string, T>, id: string, value: T): () => void {
    if (map.has(id)) throw new Error(`${id} is already registered`);
    map.set(id, value);
    this.changes.emit();
    return () => {
      if (map.get(id) !== value) return;
      map.delete(id);
      this.changes.emit();
    };
  }
}

function conditional<T extends { readonly when?: string }>(
  item: T,
): Conditional<T> {
  return {
    item,
    when: item.when === undefined ? undefined : parseWhen(item.when),
  };
}

function byOrder(
  a: { readonly order?: number },
  b: { readonly order?: number },
) {
  return (a.order ?? 0) - (b.order ?? 0);
}
