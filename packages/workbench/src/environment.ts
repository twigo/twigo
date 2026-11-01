import type { Backend, ShellEnvironment } from "@twigo/protocol";
import { Changes } from "./changes";
import type { ContextKeys } from "./contextkey/service";

/**
 * Where the login shell's environment stands, as Rust reports it
 * (ARCHITECTURE 6.1), in the `shellEnvironment` context key too.
 */
export class ShellEnvironmentStatus {
  readonly changes = new Changes();
  #current: ShellEnvironment = { state: "resolving" };
  #retrying = false;
  #detailsOpen = false;

  constructor(
    private readonly backend: Backend,
    private readonly keys: ContextKeys,
  ) {
    keys.set("shellEnvironment", this.#current.state);
  }

  get current(): ShellEnvironment {
    return this.#current;
  }

  /** Resolving again after a failure, rather than at startup. */
  get retrying(): boolean {
    return this.#retrying;
  }

  get detailsOpen(): boolean {
    return this.#detailsOpen;
  }

  setDetailsOpen(open: boolean): void {
    this.#detailsOpen = open;
    this.changes.emit();
  }

  async watch(): Promise<void> {
    // A change sent before the answer is newer than the answer.
    const early = { changed: false };
    const answer = await this.backend.subscribe(
      "shell_environment_watch",
      null,
      (next) => {
        early.changed = true;
        this.#set(next);
      },
    );
    if (!early.changed) this.#set(answer);
  }

  async retry(): Promise<void> {
    this.#detailsOpen = false;
    await this.backend.invoke("shell_environment_retry", null);
  }

  #set(next: ShellEnvironment): void {
    this.#retrying =
      next.state === "resolving" &&
      (this.#retrying || this.#current.state === "failed");
    this.#current = next;
    this.keys.set("shellEnvironment", next.state);
    this.changes.emit();
  }
}
