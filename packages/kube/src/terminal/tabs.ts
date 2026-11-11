import type { TerminalKind, TerminalSession } from "@twigo/protocol";
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
  #kind: TerminalKind | undefined;

  constructor(
    readonly input: TerminalInput,
    options: TerminalOptions,
    changed: () => void,
    session: TerminalStart | undefined,
  ) {
    super(options, changed, session);
    this.#kind = session?.kind;
  }

  /** How it reaches clusters; none for a tab restored from the saved layout. */
  get kind(): TerminalKind | undefined {
    return this.#kind;
  }

  override start(session: TerminalStart): void {
    this.#kind = session.kind;
    super.start(session);
  }
}

export class TerminalTabs extends ShellTabs<
  TerminalInput,
  TerminalStart,
  TerminalTab
> {
  constructor(options: TerminalOptions) {
    super(
      (input, changed, session) =>
        new TerminalTab(input, options, changed, session),
    );
  }
}
