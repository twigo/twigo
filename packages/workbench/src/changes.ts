/**
 * Change notification for the workbench's registries and stores: React reads
 * `version` through `useSyncExternalStore` and re-renders when it moves.
 */
export class Changes {
  readonly #listeners = new Set<() => void>();
  #version = 0;

  get version(): number {
    return this.#version;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  emit(): void {
    this.#version++;
    for (const listener of this.#listeners) listener();
  }
}
