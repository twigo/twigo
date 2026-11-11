import type { ShellEnd } from "@twigo/protocol";
import type { Tone } from "@twigo/ui";
import type { SessionStatus } from "./terminal";

/** What a tab says of an ending, in the tab and once in the scrollback (ARCHITECTURE 4.6). */
export interface Ending {
  readonly title: string;
  /** More lines, such as the runtime's message. */
  readonly detail?: string;
  /** The tab's short state: `Exit 1`. */
  readonly label: string;
  readonly tone: Tone;
}

export function ending(end: ShellEnd): Ending {
  switch (end.reason) {
    case "exited":
      return end.code === 0
        ? { title: "Session ended.", label: "Ended", tone: "idle" }
        : {
            title: `Session ended with exit code ${String(end.code)}.`,
            label: `Exit ${String(end.code)}`,
            tone: "warn",
          };
    case "signaled":
      return {
        title: `Session ended by SIG${end.signal}.`,
        label: `SIG${end.signal}`,
        tone: "warn",
      };
    case "detached":
      return { title: "The attach ended.", label: "Ended", tone: "idle" };
    case "noShell":
      return {
        title: "This container has no shell.",
        detail: end.message,
        label: "No shell",
        tone: "warn",
      };
    case "failed":
      return { title: end.error.message, label: "Failed", tone: "error" };
    case "connectionLost":
      return {
        title: "The connection was lost. A shell cannot be resumed.",
        label: "Connection lost",
        tone: "error",
      };
    case "relocked":
      return {
        title: "The context became read-only.",
        label: "Read-only",
        tone: "warn",
      };
  }
}

/** A tab's state in a word, in the tone that tells it, pulsing while it is in flight. */
export function stateOf(status: SessionStatus): {
  readonly label: string;
  readonly tone: Tone;
  readonly pulse?: true;
} {
  switch (status.state) {
    case "restored":
      return { label: "Ended", tone: "idle" };
    case "connecting":
      return { label: "Connecting", tone: "idle", pulse: true };
    case "queued":
      return { label: "Queued", tone: "warn", pulse: true };
    case "running":
      return { label: "Running", tone: "ok" };
    case "ended": {
      const { label, tone } = ending(status.end);
      return { label, tone };
    }
  }
}
