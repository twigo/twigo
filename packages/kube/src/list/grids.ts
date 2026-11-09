/**
 * The grid of each mounted list editor, by URI, so the editor can give it the
 * keyboard focus: the list keys act on the grid that has the focus.
 */
export class ListGrids {
  readonly #grids = new Map<string, HTMLElement>();

  /** Holds the grid for as long as it is mounted. */
  add(uri: string, grid: HTMLElement): () => void {
    this.#grids.set(uri, grid);
    return () => {
      if (this.#grids.get(uri) === grid) this.#grids.delete(uri);
    };
  }

  focus(uri: string): void {
    this.#grids.get(uri)?.focus();
  }
}
