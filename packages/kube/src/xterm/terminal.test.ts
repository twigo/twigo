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
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
  document.documentElement.removeAttribute("style");
});

const EXEC = { space: "qa", namespace: "auth", pod: "api-0", container: "api" };
const TERMINAL = { space: "qa", n: 1 };

interface Starter {
  readonly start: (id: number) => ShellTerminal;
  readonly restored: () => ShellTerminal;
}

const SHELLS: readonly {
  readonly name: string;
  readonly starter: (options: TerminalOptions) => Starter;
}[] = [
  {
    name: "a pod shell",
    starter: (options) => {
      const tabs = new ExecTabs(options);
      const uri = execUri(EXEC);
      return {
        start: (id) => {
          tabs.start(uri, EXEC, { id, tty: true, stdin: true });
          const tab = tabs.get(uri);
          if (!tab) throw new Error("no tab");
          return tab;
        },
        restored: () => tabs.tab(uri, EXEC),
      };
    },
  },
  {
    name: "a terminal",
    starter: (options) => {
      const tabs = new TerminalTabs(options);
      const uri = terminalUri(TERMINAL);
      return {
        start: (id) => {
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
        },
        restored: () => tabs.tab(uri, TERMINAL),
      };
    },
  },
];

const LOST = "The connection was lost. A shell cannot be resumed.";

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
  function setup(onOpen?: Parameters<typeof fakeShells>[0]) {
    const fake = fakeShells(onOpen);
    const tabs = starter({
      backend: fake.backend,
      platform: "mac",
      report: vi.fn(),
      openUrl: vi.fn(),
      binds: () => false,
    });
    const show = (tab: ShellTerminal) => {
      if (!tab.host.isConnected) {
        sized(tab);
        const container = document.createElement("div");
        document.body.append(container);
        tab.attach(container);
        tab.setShown(true);
      }
    };
    const begin = (id: number) => {
      const tab = tabs.start(id);
      show(tab);
      return tab;
    };
    return {
      fake,
      begin,
      show,
      restored: tabs.restored,
      restart: tabs.start,
      start: async (id: number) => {
        const tab = begin(id);
        await vi.advanceTimersByTimeAsync(10);
        return tab;
      },
      output: async (session: number, text: string) => {
        fake.opens[session]?.send({ state: "running" });
        fake.opens[session]?.send(bytes(text));
        await vi.advanceTimersByTimeAsync(10);
      },
      refit: (tab: ShellTerminal, width: number) => {
        sized(tab, width);
        tab.setShown(false);
        tab.setShown(true);
      },
      end: (session: number) => {
        fake.opens[session]?.send({
          state: "ended",
          end: { reason: "connectionLost" },
        });
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

  test("a restart while a program holds the alternate screen starts the new shell on the main screen", async () => {
    const { start, output } = setup();
    const tab = await start(7);
    await output(0, "you@mac ~ % vi\r\n\x1b[?1049h\x1b[Hfile");
    expect(tab.term.buffer.active.type).toBe("alternate");

    await start(8);
    await output(1, "you@mac ~ % ");
    expect(tab.term.buffer.active.type).toBe("normal");
    expect(lines(tab)).toEqual(["you@mac ~ % vi", "you@mac ~ %"]);
  });

  test("a start straight after an ending on the alternate screen leaves the ending's words above the new prompt, with the cursor shown", async () => {
    const { start, begin, output, end } = setup();
    const tab = await start(7);
    await output(0, "you@mac ~ % vi\r\n\x1b[?1049h\x1b[Hfile");
    end(0);
    begin(8);
    await vi.advanceTimersByTimeAsync(10);
    await output(1, "you@mac ~ % ");
    expect(tab.term.buffer.active.type).toBe("normal");
    expect(lines(tab)).toEqual(["you@mac ~ % vi", "", LOST, "you@mac ~ %"]);
    expect(tab.term.modes.showCursor).toBe(true);
  });

  test("a start straight after an ending on the main screen leaves the ending's words above the new prompt, with the cursor shown", async () => {
    const { start, begin, output, end } = setup();
    const tab = await start(7);
    await output(0, "you@mac ~ % ");
    end(0);
    begin(8);
    await vi.advanceTimersByTimeAsync(10);
    await output(1, "you@mac ~ % ");
    expect(lines(tab)).toEqual(["you@mac ~ %", LOST, "you@mac ~ %"]);
    expect(tab.term.modes.showCursor).toBe(true);
  });

  test("a restart after a program set a colour and took the alternate screen draws the new session in the default colour", async () => {
    const { start, output } = setup();
    const tab = await start(7);
    await output(0, "you@mac ~ % \x1b[31m\x1b[?1049h\x1b[Hfile");
    await start(8);
    await output(1, "P");
    const { active } = tab.term.buffer;
    const cell = active.getLine(active.baseY + active.cursorY)?.getCell(0);
    expect(cell?.getChars()).toBe("P");
    expect(cell?.isFgDefault()).toBe(true);
  });

  test("two starts at once open only the last session", async () => {
    const { start, begin, output, fake } = setup();
    const tab = await start(7);
    await output(0, "you@mac ~ % ");
    begin(8);
    begin(9);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.opens.map(({ request }) => request.id)).toEqual([7, 9]);
    await output(1, "you@mac ~ % ");
    expect(lines(tab)).toEqual(["you@mac ~ %", "you@mac ~ %"]);
  });

  test("output that comes with the open goes on a line of its own", async () => {
    const { start, output } = setup(({ request, send }) => {
      if (request.id === 8) {
        send({ state: "running" });
        send(bytes("EAGER% "));
      }
    });
    const tab = await start(7);
    await output(0, "you@mac ~ % ");
    await start(8);
    expect(lines(tab)).toEqual(["you@mac ~ %", "EAGER%"]);
  });

  test("a first session starts at the top of an empty terminal", async () => {
    const { start, output } = setup();
    const tab = await start(7);
    await output(0, "you@mac ~ % ");
    expect(lines(tab)).toEqual(["you@mac ~ %"]);
  });

  test("a resize while an ending waits to be parsed leaves the ending's words, and a restart after it opens", async () => {
    const { start, begin, refit, output, end, fake } = setup();
    const tab = await start(7);
    await output(0, "you@mac ~ % ");
    end(0);
    await Promise.resolve();
    refit(tab, 600);
    await vi.advanceTimersByTimeAsync(10);
    expect(lines(tab)).toEqual(["you@mac ~ %", LOST]);
    begin(8);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.opens.map(({ request }) => request.id)).toEqual([7, 8]);
  });

  test("a resize while a start waits to be parsed still opens its session", async () => {
    const { start, begin, refit, output, fake } = setup();
    const tab = await start(7);
    await output(0, "you@mac ~ % ");
    begin(8);
    await Promise.resolve();
    refit(tab, 600);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.opens.map(({ request }) => request.id)).toEqual([7, 8]);
    await output(1, "you@mac ~ % ");
    expect(lines(tab)).toEqual(["you@mac ~ %", "you@mac ~ %"]);
  });

  test("a restored tab restarted twice shows the ending's words and opens both sessions", async () => {
    const { restored, restart, show, output, end, fake } = setup();
    const tab = restored();
    restart(8);
    await Promise.resolve();
    show(tab);
    await vi.advanceTimersByTimeAsync(10);
    await output(0, "you@mac ~ % ");
    end(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(lines(tab)).toEqual(["you@mac ~ %", LOST]);
    restart(9);
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.opens.map(({ request }) => request.id)).toEqual([8, 9]);
  });

  test.fails(
    "a resize between two slices of output parses none of it twice",
    async () => {
      const { start, fake } = setup();
      const tab = await start(7);
      fake.opens[0]?.send({ state: "running" });
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => (now += 13));
      for (const text of ["A\r\n", "B\r\n", "C\r\n", "D\r\n"]) {
        fake.opens[0]?.send(bytes(text));
      }
      await vi.advanceTimersToNextTimerAsync();
      tab.term.resize(tab.term.cols - 1, tab.term.rows);
      await vi.advanceTimersByTimeAsync(10);
      expect(lines(tab)).toEqual(["A", "B", "C", "D"]);
      const acked = (fake.sent("shell_ack") as { bytes: number }[]).reduce(
        (sum, ack) => sum + ack.bytes,
        0,
      );
      expect(acked).toBe(12);
    },
  );
});
