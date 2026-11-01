import type { SerializedDockview } from "dockview-react";
import type { Backend, Space } from "@twigo/protocol";
import { Changes } from "../changes";
import type { ContextKeys } from "../contextkey/service";
import { LOCATIONS, type Location } from "../views/registry";

export interface PartState {
  readonly visible: boolean;
  /** Width of a side bar or height of the panel, once the user resized it. */
  readonly size: number | undefined;
  /** The container shown, once the user picked one. */
  readonly container: string | undefined;
}

/** What a space remembers (ARCHITECTURE 4.1, 4.2). */
export interface SpaceState {
  readonly editors: SerializedDockview | undefined;
  readonly parts: Readonly<Record<Location, PartState>>;
  /** Views the user moved, by view ID: the container they now live in. */
  readonly placement: Readonly<Record<string, string>>;
  /** Empty for every namespace. */
  readonly namespaces: readonly string[];
  /** What each view keeps, by view ID, read back unchecked: the view checks it. */
  readonly views: Readonly<Record<string, unknown>>;
}

export const DEFAULT_STATE: SpaceState = {
  editors: undefined,
  parts: {
    sidebar: { visible: true, size: undefined, container: undefined },
    panel: { visible: false, size: undefined, container: undefined },
    secondary: { visible: false, size: undefined, container: undefined },
  },
  placement: {},
  namespaces: [],
  views: {},
};

const SAVE_MS = 300;

/**
 * The spaces of the window and the state of each. Switching spaces moves the
 * whole workbench; every change of a space's state is saved through the
 * backend, debounced.
 */
export class Spaces {
  readonly changes = new Changes();
  #list: readonly Space[] = [];
  #active: string | undefined;
  readonly #states = new Map<string, SpaceState>();
  readonly #saves = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly backend: Backend,
    private readonly keys: ContextKeys,
    private readonly onError: (error: unknown) => void,
  ) {}

  get list(): readonly Space[] {
    return this.#list;
  }

  get active(): Space | undefined {
    return this.#list.find((space) => space.id === this.#active);
  }

  /** Reads the spaces and their saved states, then selects the first space. */
  async load(): Promise<void> {
    const list = await this.backend.invoke("spaces_list", null);
    await Promise.all(list.map((space) => this.#restore(space.id)));
    this.#setList(list);
    const first = list[0];
    if (first) this.select(first.id);
    else this.changes.emit();
  }

  select(id: string): void {
    const space = this.#list.find((candidate) => candidate.id === id);
    if (!space) throw new Error(`no space ${id}`);
    this.#active = id;
    const names = space.contexts.map((context) => context.name);
    this.keys.set("space.contexts", names);
    this.keys.set("space.multiContext", names.length > 1);
    this.keys.set("context.name", names.length === 1 ? names[0] : undefined);
    this.changes.emit();
  }

  /** The one-context space of a context, created if needed, becomes active. */
  async open(context: string): Promise<Space> {
    const space = await this.backend.invoke("space_open", context);
    if (!this.#list.some((candidate) => candidate.id === space.id)) {
      await this.#restore(space.id);
      this.#setList([...this.#list, space]);
    }
    this.select(space.id);
    return space;
  }

  state(id: string): SpaceState {
    return this.#states.get(id) ?? DEFAULT_STATE;
  }

  update(id: string, change: (state: SpaceState) => SpaceState): void {
    const before = this.state(id);
    const after = change(before);
    if (after === before) return;
    this.#states.set(id, after);
    this.changes.emit();
    clearTimeout(this.#saves.get(id));
    this.#saves.set(
      id,
      setTimeout(() => {
        this.#saves.delete(id);
        const value = JSON.stringify(after);
        this.backend
          .invoke("state_set", { key: stateKey(id), value })
          .catch(this.onError);
      }, SAVE_MS),
    );
  }

  setPart(id: string, location: Location, part: Partial<PartState>): void {
    this.update(id, (state) => {
      const current = state.parts[location];
      const next = { ...current, ...part };
      if (LOCATION_KEYS.every((key) => next[key] === current[key]))
        return state;
      return { ...state, parts: { ...state.parts, [location]: next } };
    });
  }

  view(id: string, view: string): unknown {
    return this.state(id).views[view];
  }

  setView(id: string, view: string, value: unknown): void {
    this.update(id, (state) => ({
      ...state,
      views: { ...state.views, [view]: value },
    }));
  }

  #setList(list: readonly Space[]) {
    this.#list = list;
    this.keys.set("space.count", list.length);
  }

  async #restore(id: string): Promise<void> {
    const saved = await this.backend.invoke("state_get", stateKey(id));
    this.#states.set(id, saved === null ? DEFAULT_STATE : readState(saved));
  }
}

const LOCATION_KEYS = ["visible", "size", "container"] as const;

function stateKey(id: string): string {
  return `space/${id}`;
}

/** A saved state, checked field by field: what does not fit falls back to the default. */
export function readState(json: string): SpaceState {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return DEFAULT_STATE;
  }
  if (!isRecord(value)) return DEFAULT_STATE;
  const parts = isRecord(value.parts) ? value.parts : {};
  return {
    editors: isRecord(value.editors)
      ? (value.editors as unknown as SerializedDockview)
      : undefined,
    parts: Object.fromEntries(
      LOCATIONS.map((location) => [
        location,
        readPart(parts[location], location),
      ]),
    ) as Record<Location, PartState>,
    placement: isRecord(value.placement)
      ? Object.fromEntries(
          Object.entries(value.placement).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {},
    namespaces: Array.isArray(value.namespaces)
      ? value.namespaces.filter(
          (name): name is string => typeof name === "string",
        )
      : [],
    views: isRecord(value.views) ? value.views : {},
  };
}

function readPart(value: unknown, location: Location): PartState {
  const fallback = DEFAULT_STATE.parts[location];
  if (!isRecord(value)) return fallback;
  return {
    visible:
      typeof value.visible === "boolean" ? value.visible : fallback.visible,
    size:
      typeof value.size === "number" && value.size > 0 ? value.size : undefined,
    container:
      typeof value.container === "string" ? value.container : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
