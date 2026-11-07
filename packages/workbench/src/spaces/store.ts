import type { SerializedDockview } from "dockview-react";
import * as v from "valibot";
import type { Backend, Space } from "@twigo/protocol";
import { Changes } from "../changes";
import type { ContextKeys } from "../contextkey/service";
import type { RecentEditor } from "../editors/recent";
import type { StateStore } from "../state/store";
import type { Location } from "../views/registry";
import type { Catalog } from "./catalog";

export interface SideBarState {
  readonly visible: boolean;
  /** The container shown, once the user picked one. */
  readonly container?: string | undefined;
}

export interface PanelState {
  readonly visible: boolean;
  /** Over the editor area, which it hides, as VS Code's maximized panel. */
  readonly maximized: boolean;
}

export interface PartStates {
  readonly sidebar: SideBarState;
  readonly panel: PanelState;
  readonly secondary: SideBarState;
}

/** What a space remembers (ARCHITECTURE 4.1, 4.2); part sizes are the app's ({@link PartSizes}). */
export interface SpaceState {
  readonly editors: SerializedDockview | undefined;
  /** The panel's own editors, its logs tabs. */
  readonly panelEditors: SerializedDockview | undefined;
  readonly parts: PartStates;
  /** Views the user moved, by view ID: the container they now live in. */
  readonly placement: Readonly<Record<string, string>>;
  /** Empty for every namespace. */
  readonly namespaces: readonly string[];
  /** The editors it opened, newest first ({@link RecentEditors}). */
  readonly recent: readonly RecentEditor[];
}

export const DEFAULT_STATE: SpaceState = {
  editors: undefined,
  panelEditors: undefined,
  parts: {
    sidebar: { visible: true, container: undefined },
    panel: { visible: false, maximized: false },
    secondary: { visible: false, container: undefined },
  },
  placement: {},
  namespaces: [],
  recent: [],
};

const sideBar = (fallback: SideBarState) =>
  v.fallback(
    v.object({
      visible: v.fallback(v.boolean(), fallback.visible),
      // Optional, not undefinedable: JSON drops an undefined container, and
      // `v.object` rejects a missing key unless its schema is optional.
      container: v.fallback(v.optional(v.string()), undefined),
    }),
    fallback,
  );

const layout = v.custom<SerializedDockview>(
  (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value),
);

/** Each key of a space's state and how it reads back; what does not fit falls back to the default. */
const SCHEMAS: {
  readonly [K in keyof SpaceState]: v.GenericSchema<unknown, SpaceState[K]>;
} = {
  editors: layout,
  panelEditors: layout,
  parts: v.object({
    sidebar: sideBar(DEFAULT_STATE.parts.sidebar),
    panel: v.fallback(
      v.object({
        visible: v.fallback(v.boolean(), DEFAULT_STATE.parts.panel.visible),
        maximized: v.fallback(v.boolean(), DEFAULT_STATE.parts.panel.maximized),
      }),
      DEFAULT_STATE.parts.panel,
    ),
    secondary: sideBar(DEFAULT_STATE.parts.secondary),
  }),
  placement: v.record(v.string(), v.string()),
  namespaces: v.array(v.string()),
  recent: v.array(v.object({ uri: v.string(), title: v.string() })),
};

const KEYS = Object.keys(SCHEMAS) as (keyof SpaceState)[];

const ACTIVE = "spaces/active";

function viewKey(view: string): string {
  return `view/${view}`;
}

/**
 * The spaces of the window and the state of each. Switching spaces moves
 * the whole workbench. The rail shows the spaces whose contexts the catalog
 * lists; the others keep their state until their contexts come back.
 */
export class Spaces {
  readonly changes = new Changes();
  /** Undefined until loaded. */
  #all: readonly Space[] | undefined;
  #active: string | undefined;
  #opening = false;
  readonly #states = new Map<string, SpaceState>();
  readonly #views = new Map<string, Map<string, unknown>>();

  constructor(
    private readonly backend: Backend,
    private readonly store: StateStore,
    private readonly catalog: Catalog,
    private readonly keys: ContextKeys,
    private readonly onError: (error: unknown) => void,
  ) {
    catalog.changes.subscribe(() => {
      if (this.#all) this.#refresh();
    });
  }

  /** The spaces the rail shows; every saved one until the catalog is read. */
  get list(): readonly Space[] {
    const all = this.#all ?? [];
    if (this.catalog.list === undefined) return all;
    return all.filter((space) =>
      space.contexts.every((name) => this.catalog.find(name)),
    );
  }

  get active(): Space | undefined {
    return this.list.find((space) => space.id === this.#active);
  }

  /** Reads the spaces, then selects the one active when the app last ran, else the first. */
  async load(): Promise<void> {
    this.#all = await this.backend.invoke("spaces_list", null);
    this.#active = this.store.get(null, ACTIVE, v.string(), undefined);
    this.#refresh();
  }

  select(id: string): void {
    const space = this.list.find((candidate) => candidate.id === id);
    if (!space) throw new Error(`no space ${id}`);
    this.#active = id;
    this.store.set(null, ACTIVE, id);
    this.#setKeys(space);
    this.changes.emit();
  }

  /** The one-context space of a context, created if needed, becomes active. */
  async open(context: string): Promise<Space> {
    const space = await this.backend.invoke("space_open", context);
    // Another open of the same context may have added the space meanwhile.
    const all = this.#all ?? [];
    if (!all.some((candidate) => candidate.id === space.id)) {
      this.#all = [...all, space];
      this.keys.set("space.count", this.list.length);
    }
    this.select(space.id);
    return space;
  }

  state(id: string): SpaceState {
    let state = this.#states.get(id);
    if (!state) {
      const read = <K extends keyof SpaceState>(key: K) =>
        this.store.get(id, key, SCHEMAS[key], DEFAULT_STATE[key]);
      state = {
        editors: read("editors"),
        panelEditors: read("panelEditors"),
        parts: read("parts"),
        placement: read("placement"),
        namespaces: read("namespaces"),
        recent: read("recent"),
      };
      this.#states.set(id, state);
    }
    return state;
  }

  update(id: string, change: (state: SpaceState) => SpaceState): void {
    const before = this.state(id);
    const after = change(before);
    if (after === before) return;
    this.#states.set(id, after);
    for (const key of KEYS) {
      if (after[key] !== before[key]) this.store.set(id, key, after[key]);
    }
    this.changes.emit();
  }

  setPart<L extends Location>(
    id: string,
    location: L,
    part: Partial<PartStates[L]>,
  ): void {
    this.update(id, (state) => {
      const current = state.parts[location];
      const next = { ...current, ...part };
      const keys = Object.keys(next) as (keyof PartStates[L])[];
      if (keys.every((key) => next[key] === current[key])) return state;
      return { ...state, parts: { ...state.parts, [location]: next } };
    });
  }

  /** What a view keeps in a space, read back unchecked: the view checks it. */
  view(id: string, view: string): unknown {
    const views = this.#viewsOf(id);
    if (!views.has(view)) {
      views.set(
        view,
        this.store.get(id, viewKey(view), v.unknown(), undefined),
      );
    }
    return views.get(view);
  }

  setView(id: string, view: string, value: unknown): void {
    this.#viewsOf(id).set(view, value);
    this.store.set(id, viewKey(view), value);
    this.changes.emit();
  }

  #viewsOf(id: string): Map<string, unknown> {
    let views = this.#views.get(id);
    if (!views) {
      views = new Map();
      this.#views.set(id, views);
    }
    return views;
  }

  /**
   * Keeps the selection on a space the rail shows, and opens the first
   * context's space when the catalog lists contexts but no space has them.
   */
  #refresh(): void {
    const list = this.list;
    this.keys.set("space.count", list.length);
    const active = this.active ?? list[0];
    if (active && active.id !== this.#active) this.select(active.id);
    else this.#setKeys(active);
    this.changes.emit();
    const first = this.catalog.list?.[0];
    if (list.length === 0 && first && !this.#opening) {
      this.#opening = true;
      this.open(first.name)
        .catch(this.onError)
        .finally(() => {
          this.#opening = false;
        });
    }
  }

  #setKeys(space: Space | undefined): void {
    const contexts = space?.contexts ?? [];
    this.keys.set("space.contexts", contexts);
    this.keys.set("space.multiContext", contexts.length > 1);
    const only = contexts.length === 1 ? contexts[0] : undefined;
    this.keys.set("context.name", only);
    const access =
      only === undefined ? undefined : this.catalog.find(only)?.access;
    this.keys.set("context.mode", access?.mode);
    this.keys.set("context.readOnly", access?.mode === "read-only");
    this.keys.set("context.unlocked", Boolean(access?.unlockedUntil));
  }
}
