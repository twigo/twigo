import type { Backend } from "@twigo/protocol";
import { Changes } from "../changes";
import type { ErrorLike } from "../errors";

/**
 * What Twigo's own files could not do, as Rust lists it (ARCHITECTURE 4.10):
 * the list is the run's and changes as a report of a code replaces its last.
 */
export class Problems {
  readonly changes = new Changes();
  #list: readonly ErrorLike[] = [];
  #told = new Set<string>();
  #listed = false;
  #open = false;

  /** `announce` is told of each problem the first time its code is listed. */
  constructor(
    private readonly backend: Backend,
    private readonly announce: (problem: ErrorLike) => void,
  ) {}

  get list(): readonly ErrorLike[] {
    return this.#list;
  }

  /** Whether the status bar's popover of them is open: `problems:status`. */
  get open(): boolean {
    return this.#open;
  }

  setOpen(open: boolean): void {
    this.#open = open;
    this.changes.emit();
  }

  async watch(): Promise<void> {
    const first = await this.backend.subscribe(
      "problems_watch",
      null,
      (next) => {
        this.#set(next);
      },
    );
    // Tauri sends channel messages apart from the command's response, so a
    // change may arrive first; it is the newer list.
    if (!this.#listed) this.#set(first);
  }

  #set(list: readonly ErrorLike[]): void {
    this.#listed = true;
    this.#list = list;
    this.changes.emit();
    for (const problem of list) {
      if (this.#told.has(problem.code)) continue;
      this.#told.add(problem.code);
      this.announce(problem);
    }
  }
}
