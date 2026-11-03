import type { Spaces } from "../spaces/store";
import type { Editors } from "./registry";

export interface RecentEditor {
  readonly uri: string;
  /** Its tab's title when it was last active. */
  readonly title: string;
}

const SIZE = 20;

/**
 * The editors each space opened, newest first, kept in the space's state
 * (ARCHITECTURE 4.5, 4.8): an editor counts each time it becomes the
 * active one, as VS Code's editor history counts it, and again when its
 * title changes meanwhile.
 */
export class RecentEditors {
  /** The active editor and its title as last recorded. */
  #seen: RecentEditor | undefined;

  constructor(
    private readonly editors: Editors,
    private readonly spaces: Spaces,
  ) {
    editors.changes.subscribe(() => {
      this.#record();
    });
  }

  /** Changes with the spaces' state. */
  get changes() {
    return this.spaces.changes;
  }

  list(space: string): readonly RecentEditor[] {
    return this.spaces.state(space).recent;
  }

  #record(): void {
    const uri = this.editors.active;
    const title = uri === undefined ? undefined : this.editors.title(uri);
    const seen = this.#seen;
    if (seen?.uri === uri && seen?.title === title) return;
    this.#seen =
      uri === undefined || title === undefined ? undefined : { uri, title };
    const space = this.spaces.active;
    if (!this.#seen || !space) return;
    const entry = this.#seen;
    this.spaces.update(space.id, (state) => ({
      ...state,
      recent: [
        entry,
        ...state.recent.filter((recent) => recent.uri !== entry.uri),
      ].slice(0, SIZE),
    }));
  }
}
