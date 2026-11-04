import type { ComponentType, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { ContextColor } from "@twigo/protocol";
import type { Tone } from "@twigo/ui";
import { Changes } from "../changes";
import {
  evaluate,
  parseWhen,
  type Lookup,
  type When,
} from "../contextkey/when";

/** A part that shows and hides, and keeps its size (ARCHITECTURE 4.1). */
export type Location = "sidebar" | "panel" | "secondary";

/** Where a view container sits; the panel holds inputs by URI instead (ARCHITECTURE 4.1). */
export type SideBar = Exclude<Location, "panel">;

export const SIDE_BARS: readonly SideBar[] = ["sidebar", "secondary"];

export const LOCATION_TITLES: Readonly<Record<Location, string>> = {
  sidebar: "Primary Side Bar",
  panel: "Panel",
  secondary: "Secondary Side Bar",
};

export interface ViewContainer {
  readonly id: string;
  readonly title: string;
  readonly icon: LucideIcon;
  readonly location: SideBar;
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

/**
 * One entry of the status bar, as data (ARCHITECTURE 4.1): the bar draws
 * every entry alike, so a contribution says what it shows, not how.
 */
export interface StatusEntry {
  /** Unique within its item. */
  readonly id: string;
  readonly text: string;
  readonly icon?: LucideIcon;
  /** Spins the icon while work is under way. */
  readonly spin?: boolean;
  /** A dot before the text. */
  readonly tone?: Tone;
  /** The context's colour behind the entry, as the rail's tile has it. */
  readonly accent?: ContextColor;
  readonly tooltip?: string;
  /** A click; without one the entry only shows. */
  readonly run?: () => void;
  /** Set when `run` shows or hides something. */
  readonly expanded?: boolean;
  /** A popover the entry opens, dismissed by Escape or a click elsewhere. */
  readonly popover?: {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly content: ReactNode;
  };
  /** A panel that stays above the entry until its owner closes it. */
  readonly panel?: ReactNode;
}

export interface StatusBarItem {
  readonly id: string;
  readonly alignment: Alignment;
  /** Higher sits further out: leftmost on the left, rightmost on the right. */
  readonly priority: number;
  readonly when?: string;
  /** A hook: the entries to show now, none to show nothing. */
  readonly useEntries: () => readonly StatusEntry[];
}

/**
 * What the editor area of a space shows while no editor is open, in place
 * of the workbench's own key hints, such as a cluster's home.
 */
export interface Watermark {
  readonly id: string;
  readonly when?: string;
  readonly component: ComponentType<{ readonly space: string }>;
}

interface Conditional<T> {
  readonly item: T;
  readonly when: When | undefined;
}

/** The view containers, views, status-bar items and watermarks that features contribute. */
export class Views {
  readonly changes = new Changes();
  readonly #containers = new Map<string, ViewContainer>();
  readonly #views = new Map<string, Conditional<View>>();
  readonly #items = new Map<string, Conditional<StatusBarItem>>();
  readonly #watermarks = new Map<string, Conditional<Watermark>>();

  registerContainer(container: ViewContainer): () => void {
    return this.#add(this.#containers, container.id, container);
  }

  registerView(view: View): () => void {
    return this.#add(this.#views, view.id, conditional(view));
  }

  registerStatusBarItem(item: StatusBarItem): () => void {
    return this.#add(this.#items, item.id, conditional(item));
  }

  registerWatermark(watermark: Watermark): () => void {
    return this.#add(this.#watermarks, watermark.id, conditional(watermark));
  }

  containers(location: SideBar): ViewContainer[] {
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

  /** The first registered watermark whose `when` holds. */
  watermark(lookup: Lookup): Watermark | undefined {
    for (const { item, when } of this.#watermarks.values()) {
      if (!when || evaluate(when, lookup)) return item;
    }
    return undefined;
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
