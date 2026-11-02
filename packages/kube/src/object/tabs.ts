import { Changes } from "@twigo/workbench";

export type ObjectTab = "overview" | "yaml" | "events" | "related";

export const OBJECT_TABS: readonly { id: ObjectTab; title: string }[] = [
  { id: "overview", title: "Overview" },
  { id: "yaml", title: "YAML" },
  { id: "events", title: "Events" },
  { id: "related", title: "Related" },
];

/** The view each open object editor shows, by its URI. */
export class ObjectTabs {
  readonly changes = new Changes();
  readonly #tabs = new Map<string, ObjectTab>();

  get(uri: string): ObjectTab {
    return this.#tabs.get(uri) ?? "overview";
  }

  set(uri: string, tab: ObjectTab): void {
    if (this.get(uri) === tab) return;
    this.#tabs.set(uri, tab);
    this.changes.emit();
  }
}
