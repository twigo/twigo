import type {
  Backend,
  Catalog as Listed,
  CatalogFailure,
  Context,
} from "@twigo/protocol";
import { Changes } from "../changes";

/** The contexts the backend's catalog lists, and the kubeconfig files it could not read, following its changes (ARCHITECTURE 5.5). */
export class Catalog {
  readonly changes = new Changes();
  #contexts: readonly Context[] | undefined;
  #failures: readonly CatalogFailure[] = [];

  /** `announce` is told of each file that fails and did not before. */
  constructor(
    private readonly backend: Backend,
    private readonly announce: (failure: CatalogFailure) => void = () =>
      undefined,
  ) {}

  /** Undefined until the catalog's sources have been read. */
  get list(): readonly Context[] | undefined {
    return this.#contexts;
  }

  /** The files that exist and could not be read or merged, whose contexts are missing. */
  get failures(): readonly CatalogFailure[] {
    return this.#failures;
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

  #set({ contexts, failures }: Listed): void {
    const before = new Set(this.#failures.map(({ source }) => source));
    this.#contexts = contexts;
    this.#failures = failures;
    this.changes.emit();
    for (const failure of failures) {
      if (!before.has(failure.source)) this.announce(failure);
    }
  }
}
