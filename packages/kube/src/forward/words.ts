import type { Forward } from "@twigo/protocol";
import type { Tone } from "@twigo/ui";
import { modeLabel } from "@twigo/workbench";

/** The target's port as a person names it: `http`, or its number when it has no name. */
export function portLabel({ port, portName }: Forward): string {
  return portName ?? String(port);
}

/** The target and its port as a person names them: `web:http`. */
export function targetWords(forward: Forward): string {
  return `${forward.target.name}:${portLabel(forward)}`;
}

/** The local port a forward reaches: `→ 8080`. */
export function localWords({ local }: Forward): string {
  return `→ ${String(local)}`;
}

/** A tab's title: the target and the local port it reaches, `web:http → 8080`. */
export function forwardTitle(forward: Forward): string {
  return `${targetWords(forward)} ${localWords(forward)}`;
}

/** The port as its target declares it: `http 80`, or `80` when it has no name. */
export function portWords({ port, portName }: Forward): string {
  return portName === null ? String(port) : `${portName} ${String(port)}`;
}

/** Where to reach the forward, as a person types it. */
export function addressOf({ local }: Forward): string {
  return `localhost:${String(local)}`;
}

/** The addresses a forward listens on: none while it is stopped, whatever the core still holds, and none when its port was held at the restore. */
export function listensOn({ state, addresses }: Forward): readonly string[] {
  return state.state === "stopped" ? [] : addresses;
}

export interface Shown {
  readonly label: string;
  readonly tone: Tone;
  /** While the state is in flight. */
  readonly pulse?: true;
  /** Idle because it is off: nothing listens. */
  readonly hollow?: true;
  /** More words about the state, such as why it waits. */
  readonly detail?: string;
}

/** A forward's state in a word, in the tone that tells it. */
export function stateOf({ state, queued }: Forward): Shown {
  switch (state.state) {
    case "starting":
      return { label: "Starting", tone: "idle", pulse: true };
    case "restored":
      return { label: "Restored", tone: "idle" };
    case "ready":
      return queued > 0
        ? { label: `Ready · ${String(queued)} waiting`, tone: "warn" }
        : { label: "Ready", tone: "ok" };
    case "reconnecting":
      return {
        label: "Reconnecting",
        tone: "warn",
        pulse: true,
        detail: state.reason,
      };
    case "failed":
      return state.error.blocked
        ? {
            label: modeLabel(state.error.blocked.mode),
            tone: "warn",
            detail: state.error.message,
          }
        : { label: "Failed", tone: "error", detail: state.error.message };
    case "stopped":
      return { label: "Stopped", tone: "idle", hollow: true };
  }
}

const HTTPS_NAME = /^https([-_.].*)?$|[-_.]https$/i;
const HTTP_NAME = /^(http|web)([-_.].*)?$|[-_.]http$/i;
const HTTP_PORTS: ReadonlySet<number> = new Set([80, 8000, 8008, 8080, 8888]);
const HTTPS_PORTS: ReadonlySet<number> = new Set([443, 8443]);

/**
 * The scheme a browser reaches the port with. Where the target declares an
 * `appProtocol` it decides: `http` and `https` are web and any other
 * protocol is not, whatever the port is named. Without one the name says it,
 * or the number does when it has no name; a port named for another protocol
 * is none, whatever its number.
 */
export function webOf({
  port,
  portName,
  appProtocol,
}: Forward): "http" | "https" | undefined {
  if (appProtocol !== null) {
    const declared = appProtocol.toLowerCase();
    return declared === "http" || declared === "https" ? declared : undefined;
  }
  if (portName !== null) {
    if (HTTPS_NAME.test(portName)) return "https";
    return HTTP_NAME.test(portName) ? "http" : undefined;
  }
  if (HTTPS_PORTS.has(port)) return "https";
  return HTTP_PORTS.has(port) ? "http" : undefined;
}

/** The link that opens the forward in a browser, where its port says HTTP. */
export function webUrl(forward: Forward): string | undefined {
  const scheme = webOf(forward);
  return scheme && `${scheme}://localhost:${String(forward.local)}`;
}
