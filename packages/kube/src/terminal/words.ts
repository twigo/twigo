import type { TerminalInput } from "../uri";

/** A tab's title, and the label the terminal's asks and offers call it by. */
export function terminalTitle({ n }: TerminalInput): string {
  return `Terminal ${String(n)}`;
}
