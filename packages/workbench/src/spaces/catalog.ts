import type { Backend, Context } from "@twigo/protocol";
import { Changes } from "../changes";

/** The contexts the backend's catalog lists, following its changes (ARCHITECTURE 5.5). */
export class Catalog {
  readonly changes = new Changes();
  #contexts: readonly Context[] | undefined;

  constructor(private readonly backend: Backend) {}

  /** Undefined until the catalog's sources have been read. */
  get list(): readonly Context[] | undefined {
    return this.#contexts;
  }

  find(name: string): Context | undefined {
    return this.#contexts?.find((context) => context.name === name);
  }

  async watch(): Promise<void> {
    const first = await this.backend.subscribe(
      "contexts_watch",
      null,
      (next) => {
        this.#set(next);
      },
    );
    // Tauri sends channel messages apart from the command's response, so a
    // change may arrive first; it is the newer list.
    if (this.#contexts === undefined) this.#set(first);
  }

  #set(contexts: readonly Context[]): void {
    this.#contexts = contexts;
    this.changes.emit();
  }
}
