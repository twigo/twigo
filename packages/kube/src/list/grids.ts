/**
 * The grid of each mounted list editor, by URI, so the editor can give it the
 * keyboard focus: the list keys act on the grid that has the focus.
 */
export class ListGrids {
  readonly #grids = new Map<string, HTMLElement>();
  /** The lists asked for the focus before their grid mounted, with what held it then. */
  readonly #waiting = new Map<string, Element | null>();

  /**
   * Holds the grid for as long as it is mounted. A list that asked for the
   * focus meanwhile gets it, unless the focus has moved on since: a grid shows
   * after its data arrives, when the person may have gone elsewhere.
   */
  add(uri: string, grid: HTMLElement): () => void {
    this.#grids.set(uri, grid);
    if (this.#waiting.has(uri)) {
      const held = this.#waiting.get(uri);
      this.#waiting.delete(uri);
      if (document.activeElement === held) grid.focus();
    }
    return () => {
      if (this.#grids.get(uri) === grid) this.#grids.delete(uri);
    };
  }

  /** Focuses the list's grid, or does when it mounts. */
  focus(uri: string): void {
    const grid = this.#grids.get(uri);
    if (grid) grid.focus();
    else this.#waiting.set(uri, document.activeElement);
  }

  closed(uri: string): void {
    this.#waiting.delete(uri);
  }
}
