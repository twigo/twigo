import type {
  SubscriptionId,
  TerminalKind,
  TerminalSession,
} from "@twigo/protocol";
import type { TerminalKindFacts } from "./kind";
import type { TerminalInput } from "../uri";
import { ShellTabs } from "../xterm/tabs";
import {
  ShellTerminal,
  type SessionStart,
  type TerminalOptions,
} from "../xterm/terminal";

/** A parked terminal `terminal_create` answered with, which always has a terminal and takes input. */
export type TerminalStart = TerminalSession & SessionStart;

export function started(session: TerminalSession): TerminalStart {
  return { ...session, tty: true, stdin: true };
}

/** One terminal tab: a shell on this machine (ARCHITECTURE 4.6). */
export class TerminalTab extends ShellTerminal {
  #created: TerminalSession | undefined;

  constructor(
    readonly input: TerminalInput,
    options: TerminalOptions,
    changed: () => void,
    session: TerminalStart | undefined,
  ) {
    super(options, changed, session);
    this.#created = session;
  }

  #restoredView: HTMLElement | null = null;

  /** How it reaches clusters; none for a tab restored from the saved layout. */
  get kind(): TerminalKind | undefined {
    return this.#created?.kind;
  }

  get session(): SubscriptionId | undefined {
    return this.#created?.id;
  }

  /** What the core said of the terminal it created; none for a tab restored from the saved layout. */
  get facts(): TerminalKindFacts | undefined {
    return this.#created;
  }

  /** The view of a tab nothing started, which takes the focus in place of a terminal, so that `terminalFocus` holds. */
  setRestoredView(view: HTMLElement | null): void {
    this.#restoredView = view;
  }

  override focus(): void {
    if (this.getStatus().state === "restored") this.#restoredView?.focus();
    else super.focus();
  }

  override start(session: TerminalStart): void {
    this.#created = session;
    super.start(session);
  }
}

export class TerminalTabs extends ShellTabs<
  TerminalInput,
  TerminalStart,
  TerminalTab
> {
  /** The URIs of the tabs in the order they were last active, the latest last. */
  #recent: string[] = [];

  constructor(options: TerminalOptions) {
    super(
      (input, changed, session) =>
        new TerminalTab(input, options, changed, session),
    );
  }

  touch(uri: string): void {
    if (this.#recent[this.#recent.length - 1] === uri) return;
    this.#recent = [...this.#recent.filter((each) => each !== uri), uri];
  }

  /**
   * The URI of the space's tab that was last in use, else its first tab, as
   * after a restart, when none was in use yet; undefined when it has none.
   */
  last(space: string): string | undefined {
    const inSpace = (uri: string) => this.get(uri)?.input.space === space;
    return (
      [...this.#recent].reverse().find(inSpace) ??
      this.list().find(([, tab]) => tab.input.space === space)?.[0]
    );
  }

  override closed(uri: string): void {
    this.#recent = this.#recent.filter((each) => each !== uri);
    super.closed(uri);
  }
}
