import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fakeShells, sized, withTerminalLayout } from "../../test/terminal";
import { ExecTabs } from "../exec/tabs";
import { started, TerminalTabs } from "../terminal/tabs";
import { execUri, terminalUri } from "../uri";
import type { ShellTerminal, TerminalOptions } from "./terminal";

withTerminalLayout();

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  document.documentElement.removeAttribute("style");
});

const EXEC = { space: "qa", namespace: "auth", pod: "api-0", container: "api" };
const TERMINAL = { space: "qa", n: 1 };

type Starter = (id: number) => ShellTerminal;

const SHELLS: readonly {
  readonly name: string;
  readonly starter: (options: TerminalOptions) => Starter;
}[] = [
  {
    name: "a pod shell",
    starter: (options) => {
      const tabs = new ExecTabs(options);
      const uri = execUri(EXEC);
      return (id) => {
        tabs.start(uri, EXEC, { id, tty: true, stdin: true });
        const tab = tabs.get(uri);
        if (!tab) throw new Error("no tab");
        return tab;
      };
    },
  },
  {
    name: "a terminal",
    starter: (options) => {
      const tabs = new TerminalTabs(options);
      const uri = terminalUri(TERMINAL);
      return (id) => {
        tabs.start(
          uri,
          TERMINAL,
          started({
            id,
            kind: { kind: "kubeconfig" },
            shell: "zsh",
            kubeconfigKept: true,
          }),
        );
        const tab = tabs.get(uri);
        if (!tab) throw new Error("no tab");
        return tab;
      };
    },
  },
];

const bytes = (output: string) => new TextEncoder().encode(output).buffer;

function lines(tab: ShellTerminal): string[] {
  const { active } = tab.term.buffer;
  const all = Array.from(
    { length: active.length },
    (_, i) => active.getLine(i)?.translateToString().trimEnd() ?? "",
  );
  while (all[all.length - 1] === "") all.pop();
  return all;
}

describe.each(SHELLS)("$name", ({ starter }) => {
  function setup() {
    const fake = fakeShells();
    const start = starter({
      backend: fake.backend,
      platform: "mac",
      report: vi.fn(),
      openUrl: vi.fn(),
      binds: () => false,
    });
    return {
      start: async (id: number) => {
        const tab = start(id);
        if (!tab.host.isConnected) {
          sized(tab);
          const container = document.createElement("div");
          document.body.append(container);
          tab.attach(container);
          tab.setShown(true);
        }
        await vi.advanceTimersByTimeAsync(10);
        return tab;
      },
      output: async (session: number, text: string) => {
        fake.opens[session]?.send({ state: "running" });
        fake.opens[session]?.send(bytes(text));
        await vi.advanceTimersByTimeAsync(10);
      },
    };
  }

  test("a restart while the old prompt waits for a command starts the new shell on a line of its own", async () => {
    const { start, output } = setup();
    const tab = await start(7);
    await output(0, "you@mac ~ % ");
    expect(tab.term.buffer.active.cursorX).toBeGreaterThan(0);

    await start(8);
    await output(1, "you@mac ~ % ");
    expect(lines(tab)).toEqual(["you@mac ~ %", "you@mac ~ %"]);
  });

  test("a restart after a line that ended adds no empty line", async () => {
    const { start, output } = setup();
    const tab = await start(7);
    await output(0, "first\r\n");
    expect(tab.term.buffer.active.cursorX).toBe(0);

    await start(8);
    await output(1, "second\r\n");
    expect(lines(tab)).toEqual(["first", "second"]);
  });

  test("a first session starts at the top of an empty terminal", async () => {
    const { start, output } = setup();
    const tab = await start(7);
    await output(0, "you@mac ~ % ");
    expect(lines(tab)).toEqual(["you@mac ~ %"]);
  });
});
