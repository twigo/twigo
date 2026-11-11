import { afterAll, beforeAll } from "vitest";
import type { Backend, OpenShell, ShellMessage } from "@twigo/protocol";
import type { ShellTerminal } from "../src/xterm/terminal";

/** jsdom lays nothing out, so xterm measures a cell as 0 by 0 and never fits: every element is 256 by 16, which makes a cell 8 by 16. */
export function withTerminalLayout() {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get: () => 256,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get: () => 16,
    });
  });
  afterAll(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
    Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
  });
}

export function sized(
  tab: Pick<ShellTerminal, "host">,
  width = 640,
  height = 320,
): void {
  tab.host.style.width = `${String(width)}px`;
  tab.host.style.height = `${String(height)}px`;
}

export function fakeShells() {
  const calls: { command: string; request: unknown }[] = [];
  const opens: { request: OpenShell; send: (message: ShellMessage) => void }[] =
    [];
  const backend: Backend = {
    invoke(command, request) {
      calls.push({ command, request });
      return Promise.resolve(null as never);
    },
    subscribe(command, request, onMessage) {
      calls.push({ command, request });
      if (command === "shell_open") {
        opens.push({
          request: request as OpenShell,
          send: onMessage,
        });
      }
      return Promise.resolve(null as never);
    },
  };
  return {
    backend,
    calls,
    opens,
    sent: (command: string) =>
      calls.filter((call) => call.command === command).map((c) => c.request),
  };
}

export function enter(init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  Object.defineProperty(event, "keyCode", { value: 13 });
  return event;
}
