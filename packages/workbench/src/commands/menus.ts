import {
  evaluate,
  parseWhen,
  type Lookup,
  type When,
} from "../contextkey/when";

import { Changes } from "../changes";

/** The menus of ARCHITECTURE 5.1, plus the native menu bar's submenus. */
export type MenuId =
  | "commandPalette"
  | "resource/context"
  | "resource/details"
  | "resource/marked"
  | "helm/marked"
  | "helm/revision"
  | "helm/revisions"
  | "helm/text"
  | "view/title"
  | "panel/title"
  | "panel/empty"
  | "view/item"
  | "editor/title"
  | "edit/toolbar"
  | "edit/changed"
  | "edit/server"
  | "edit/conflicts"
  | "edit/immutable"
  | "edit/diff"
  | "edit/preview"
  | "edit/answer"
  | "space/context"
  | "statusBar"
  | "explorer/kind"
  | "menubar/file"
  | "menubar/edit"
  | "menubar/view"
  | "menubar/go"
  | "menubar/window"
  | "menubar/help";

export interface MenuItem {
  readonly command: string;
  /** Items group by name, `navigation` first, then alphabetically. */
  readonly group?: string;
  readonly order?: number;
  readonly when?: string;
  /**
   * Where the item keeps its place on a row of actions, before More, as a
   * when-expression: the verbs a kind pins (ARCHITECTURE 4.3).
   */
  readonly pin?: string;
}

/** An item where its when holds, and whether it is pinned there. */
export interface Placed extends MenuItem {
  readonly pinned: boolean;
}

interface Entry {
  readonly item: MenuItem;
  readonly when: When | undefined;
  readonly pin: When | undefined;
}

/** Menus are data that point at commands, as VS Code's MenuRegistry. */
export class Menus {
  readonly #menus = new Map<MenuId, Set<Entry>>();
  readonly changes = new Changes();

  append(menu: MenuId, item: MenuItem): () => void {
    const entry = {
      item,
      when: item.when === undefined ? undefined : parseWhen(item.when),
      pin: item.pin === undefined ? undefined : parseWhen(item.pin),
    };
    const entries = this.#menus.get(menu) ?? new Set();
    entries.add(entry);
    this.#menus.set(menu, entries);
    this.changes.emit();
    return () => {
      entries.delete(entry);
      this.changes.emit();
    };
  }

  /**
   * The items whose `when` holds, in groups, each group sorted by order.
   * Without a lookup every item counts, for the native menu, which cannot
   * follow the focus, and none is pinned.
   */
  groups(menu: MenuId, lookup?: Lookup): Placed[][] {
    const groups = new Map<string, Placed[]>();
    for (const { item, when, pin } of this.#menus.get(menu) ?? []) {
      if (lookup && when && !evaluate(when, lookup)) continue;
      const name = item.group ?? "";
      const pinned =
        lookup !== undefined && pin !== undefined && evaluate(pin, lookup);
      groups.set(name, [...(groups.get(name) ?? []), { ...item, pinned }]);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => groupRank(a) - groupRank(b) || a.localeCompare(b))
      .map(([, items]) =>
        items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
      );
  }

  /**
   * Whether the item of `command` in `menu`, if there is one, lets it show;
   * the palette lists every command unless its `commandPalette` item hides it.
   */
  shows(menu: MenuId, command: string, lookup: Lookup): boolean {
    const entries = [...(this.#menus.get(menu) ?? [])].filter(
      (entry) => entry.item.command === command,
    );
    return (
      entries.length === 0 ||
      entries.some((entry) => !entry.when || evaluate(entry.when, lookup))
    );
  }
}

function groupRank(group: string): number {
  if (group === "navigation") return 0;
  return group === "" ? 2 : 1;
}
