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
  #listed = false;
  #open = false;

  /** `announce` is told of each problem whose code the list did not hold before, `cleared` of each code it holds no more, so a problem that returns is told again. */
  constructor(
    private readonly backend: Backend,
    private readonly announce: (problem: ErrorLike) => void,
    private readonly cleared: (code: string) => void,
  ) {}

  get list(): readonly ErrorLike[] {
    return this.#list;
  }

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
    const before = new Set(this.#list.map(({ code }) => code));
    const now = new Set(list.map(({ code }) => code));
    this.#listed = true;
    this.#list = list;
    this.changes.emit();
    for (const problem of list) {
      if (!before.has(problem.code)) this.announce(problem);
    }
    for (const code of before) {
      if (!now.has(code)) this.cleared(code);
    }
  }
}
