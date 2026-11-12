import type {
  Backend,
  Forward,
  ForwardEvent,
  ForwardId,
} from "@twigo/protocol";
import { Changes } from "@twigo/workbench";

/**
 * The port-forwards of every space, as the core keeps them (ARCHITECTURE
 * 4.6): this window follows them with `forwards_watch` and holds no list of
 * its own, so everything that draws a forward reads it here, by id.
 */
export class Forwards {
  readonly changes = new Changes();
  readonly #byId = new Map<ForwardId, Forward>();
  /** The forwards an event told of before the watch answered, which are newer than its list. */
  readonly #told = new Set<ForwardId>();
  readonly #settling = new Map<
    ForwardId,
    Set<(forward: Forward | undefined) => void>
  >();
  readonly #bySpace = new Map<string, readonly Forward[]>();
  readonly #selected = new Map<string, ForwardId>();
  readonly #lists = new Map<string, HTMLElement>();
  #loaded = false;

  constructor(private readonly backend: Backend) {}

  /** Whether the first list has come, before which a forward that is not here may only not have come yet. */
  get loaded(): boolean {
    return this.#loaded;
  }

  get(id: ForwardId): Forward | undefined {
    return this.#byId.get(id);
  }

  /** The forward a `pf://` address names: its id, as a forward of the space the address says. */
  find({ space, id }: { space: string; id: ForwardId }): Forward | undefined {
    const forward = this.#byId.get(id);
    return forward?.target.space === space ? forward : undefined;
  }

  /** A space's forwards in the order they were made, the same array until one changes. */
  ofSpace(space: string): readonly Forward[] {
    let found = this.#bySpace.get(space);
    if (!found) {
      found = [...this.#byId.values()]
        .filter(({ target }) => target.space === space)
        .sort((a, b) => a.id - b.id);
      this.#bySpace.set(space, found);
    }
    return found;
  }

  /** The forward the space's list has selected, while it exists. */
  selected(space: string): ForwardId | undefined {
    const id = this.#selected.get(space);
    return id !== undefined && this.#byId.get(id)?.target.space === space
      ? id
      : undefined;
  }

  select(space: string, id: ForwardId): void {
    if (this.#selected.get(space) === id) return;
    this.#selected.set(space, id);
    this.changes.emit();
  }

  /** The mounted list of a space, which a command can hand the focus back to. */
  attach(space: string, list: HTMLElement): () => void {
    this.#lists.set(space, list);
    return () => {
      if (this.#lists.get(space) === list) this.#lists.delete(space);
    };
  }

  focus(space: string): void {
    this.#lists.get(space)?.focus();
  }

  /** Follows the core's forwards; a later watch of the window replaces this one. */
  async watch(): Promise<void> {
    const first = await this.backend.subscribe(
      "forwards_watch",
      null,
      (event) => {
        this.#apply(event);
      },
    );
    // Tauri sends channel messages apart from the command's response, so an
    // event may arrive first; it is newer than the list.
    for (const forward of first) {
      if (!this.#told.has(forward.id)) this.#byId.set(forward.id, forward);
    }
    this.#told.clear();
    this.#loaded = true;
    this.#changed();
  }

  /**
   * How a start that has just answered with `started` goes on: that forward
   * at once if the answer was final, else the first change that leaves
   * starting, or undefined if the core removes it first. A change that came
   * before the answer is not looked at, since the map may still hold an
   * earlier run's state until this run's first event.
   */
  settled(started: Forward): Promise<Forward | undefined> {
    if (started.state.state !== "starting") return Promise.resolve(started);
    return new Promise((resolve) => {
      const waiting = this.#settling.get(started.id) ?? new Set();
      waiting.add(resolve);
      this.#settling.set(started.id, waiting);
    });
  }

  #apply(event: ForwardEvent): void {
    const id = event.event === "changed" ? event.forward.id : event.id;
    if (!this.#loaded) this.#told.add(id);
    if (event.event === "changed") this.#byId.set(id, event.forward);
    else {
      this.#reselect(id);
      this.#byId.delete(id);
    }
    this.#changed();
    this.#settle(id);
  }

  /** A removed forward that the list had selected leaves the next row selected, the one before it at the end. */
  #reselect(id: ForwardId): void {
    const space = this.#byId.get(id)?.target.space;
    if (space === undefined || this.#selected.get(space) !== id) return;
    const rows = this.ofSpace(space);
    const at = rows.findIndex((forward) => forward.id === id);
    const next = rows[at + 1] ?? rows[at - 1];
    if (next) this.#selected.set(space, next.id);
    else this.#selected.delete(space);
  }

  #settle(id: ForwardId): void {
    const waiting = this.#settling.get(id);
    if (!waiting) return;
    const forward = this.#byId.get(id);
    if (forward?.state.state === "starting") return;
    this.#settling.delete(id);
    for (const resolve of waiting) resolve(forward);
  }

  #changed(): void {
    this.#bySpace.clear();
    this.changes.emit();
  }
}
