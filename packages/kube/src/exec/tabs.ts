import type { ExecInput } from "../uri";
import { ShellTabs } from "../xterm/tabs";
import {
  ShellTerminal,
  type SessionStart,
  type TerminalOptions,
} from "../xterm/terminal";
import { attached } from "./words";

export type { WebglRenderer } from "../xterm/terminal";

/** A session a plan's run answered with, and how it joins its process. */
export type ExecSession = SessionStart;

/** One shell tab: an exec or an attach in a container (ARCHITECTURE 4.6). */
export class ExecTab extends ShellTerminal {
  constructor(
    readonly input: ExecInput,
    options: TerminalOptions,
    changed: () => void,
    session: ExecSession | undefined,
  ) {
    super(options, changed, session);
  }

  protected override runningWords(stdin: boolean): string | undefined {
    return this.input.attach === true
      ? attached(this.input.container, stdin)
      : undefined;
  }
}

export class ExecTabs extends ShellTabs<ExecInput, ExecSession, ExecTab> {
  constructor(options: TerminalOptions) {
    super(
      (input, changed, session) =>
        new ExecTab(input, options, changed, session),
    );
  }
}
