import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ShellEnd } from "@twigo/protocol";
import { execUri, type ExecInput } from "../uri";
import {
  enter,
  fakeShells,
  sized,
  withTerminalLayout,
} from "../../test/terminal";
import { ExecTabs, type WebglRenderer } from "./tabs";

withTerminalLayout();

const INPUT: ExecInput = {
  space: "qa",
  namespace: "auth",
  pod: "api-0",
  container: "api",
};
const URI = execUri(INPUT);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  document.documentElement.removeAttribute("style");
});
function fakeWebgl() {
  const made: { disposed: boolean; lose: () => void }[] = [];
  const factory = (): WebglRenderer => {
    let loss: (() => void) | undefined;
    const entry = {
      disposed: false,
      lose: () => {
        loss?.();
      },
    };
    made.push(entry);
    return {
      activate: () => undefined,
      dispose: () => {
        entry.disposed = true;
      },
      onContextLoss: (listener) => {
        loss = listener;
        return { dispose: () => undefined };
      },
    };
  };
  return { made, factory };
}

function setup(options: { webgl?: () => WebglRenderer; binds?: boolean } = {}) {
  const fake = fakeShells();
  const report = vi.fn();
  const openUrl = vi.fn();
  const binds = vi.fn(() => options.binds ?? false);
  const tabs = new ExecTabs({
    backend: fake.backend,
    platform: "mac",
    report,
    openUrl,
    binds,
    ...(options.webgl && { webgl: options.webgl }),
  });
  const container = () => {
    const element = document.createElement("div");
    document.body.append(element);
    return element;
  };
  const mounted = async (id = 7) => {
    tabs.start(URI, INPUT, id);
    const tab = tabs.get(URI);
    if (!tab) throw new Error("no tab");
    sized(tab);
    tab.attach(container());
    tab.setShown(true);
    await vi.advanceTimersByTimeAsync(10);
    return tab;
  };
  return { ...fake, tabs, report, openUrl, binds, container, mounted };
}

const text = (tab: {
  term: {
    buffer: {
      active: {
        length: number;
        getLine: (
          i: number,
        ) => { translateToString: (t: boolean) => string } | undefined;
      };
    };
  };
}) => {
  const lines: string[] = [];
  const { active } = tab.term.buffer;
  for (let i = 0; i < active.length; i++) {
    lines.push(active.getLine(i)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
};

const bytes = (output: string) => new TextEncoder().encode(output).buffer;

test("the session opens once the terminal is mounted and fitted, with its size", async () => {
  const { tabs, opens, container } = setup();
  tabs.start(URI, INPUT, 7);
  const tab = tabs.get(URI);
  if (!tab) throw new Error("no tab");
  await vi.advanceTimersByTimeAsync(10);
  expect(opens).toEqual([]);
  sized(tab);
  tab.attach(container());
  expect(opens).toEqual([]);
  tab.setShown(true);
  await vi.advanceTimersByTimeAsync(10);
  expect(opens.map(({ request }) => request)).toEqual([
    { id: 7, cols: 78, rows: 20 },
  ]);
  expect(tab.term.cols).toBe(78);
});

test("Start on a tab that nothing started waits for the terminal's size too", async () => {
  const { tabs, opens, container } = setup();
  const tab = tabs.tab(URI, INPUT);
  tabs.start(URI, INPUT, 7);
  await vi.advanceTimersByTimeAsync(10);
  expect(opens).toEqual([]);
  expect(tab.getStatus()).toEqual({ state: "connecting" });
  sized(tab);
  tab.attach(container());
  tab.setShown(true);
  await vi.advanceTimersByTimeAsync(10);
  expect(opens.map(({ request }) => request)).toEqual([
    { id: 7, cols: 78, rows: 20 },
  ]);
});

test("the terminal survives a remount: its element moves and nothing restarts", async () => {
  const { tabs, opens, calls, container } = setup();
  const tab = await (async () => {
    const first = container();
    tabs.start(URI, INPUT, 7);
    const made = tabs.get(URI);
    if (!made) throw new Error("no tab");
    sized(made);
    made.attach(first);
    made.setShown(true);
    await vi.advanceTimersByTimeAsync(10);
    return made;
  })();
  opens[0]?.send({ state: "running" });
  opens[0]?.send(bytes("hello\r\n"));
  await vi.advanceTimersByTimeAsync(10);
  const element = tab.host;
  const term = tab.term;

  tab.setShown(false);
  const second = container();
  tab.attach(second);
  tab.setShown(true);
  await vi.advanceTimersByTimeAsync(10);

  expect(tab.host).toBe(element);
  expect(tab.host.parentElement).toBe(second);
  expect(tab.term).toBe(term);
  expect(text(tab)).toContain("hello");
  expect(opens).toHaveLength(1);
  expect(calls.filter(({ command }) => command === "shell_close")).toEqual([]);
});

test("a hidden tab has no WebGL addon, and showing it loads one", async () => {
  const webgl = fakeWebgl();
  const { mounted } = setup({ webgl: webgl.factory });
  const tab = await mounted();
  expect(tab.renderer).toBe("webgl");
  expect(webgl.made).toHaveLength(1);

  tab.setShown(false);
  expect(tab.renderer).toBe("webgl");
  expect(webgl.made[0]?.disposed).toBe(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(tab.renderer).toBe("dom");
  expect(webgl.made[0]?.disposed).toBe(true);

  tab.setShown(true);
  expect(tab.renderer).toBe("webgl");
  expect(webgl.made).toHaveLength(2);
});

test("hiding a tab and showing it in the same task disposes nothing", async () => {
  const webgl = fakeWebgl();
  const { mounted } = setup({ webgl: webgl.factory });
  const tab = await mounted();
  tab.setShown(false);
  tab.setShown(true);
  await vi.advanceTimersByTimeAsync(10);
  expect(webgl.made).toHaveLength(1);
  expect(webgl.made[0]?.disposed).toBe(false);
  expect(tab.renderer).toBe("webgl");
});

test("a lost context falls back to the DOM renderer, and that terminal never loads WebGL again", async () => {
  const webgl = fakeWebgl();
  const { mounted } = setup({ webgl: webgl.factory });
  const tab = await mounted();
  webgl.made[0]?.lose();
  expect(tab.renderer).toBe("dom");
  expect(webgl.made[0]?.disposed).toBe(true);
  tab.setShown(false);
  await vi.advanceTimersByTimeAsync(10);
  tab.setShown(true);
  expect(tab.renderer).toBe("dom");
  expect(webgl.made).toHaveLength(1);
});

test("a WebGL that fails to load leaves the terminal on the DOM renderer, once", async () => {
  const factory = vi.fn(() => {
    throw new Error("WebGL2 not supported");
  });
  const { mounted, report } = setup({ webgl: factory });
  const tab = await mounted();
  expect(tab.renderer).toBe("dom");
  tab.setShown(false);
  await vi.advanceTimersByTimeAsync(10);
  tab.setShown(true);
  expect(factory).toHaveBeenCalledOnce();
  expect(report).not.toHaveBeenCalled();
});

test("a tab that is not shown holds no WebGL, and opens no terminal", async () => {
  const webgl = fakeWebgl();
  const { tabs, container } = setup({ webgl: webgl.factory });
  tabs.start(URI, INPUT, 7);
  const tab = tabs.get(URI);
  if (!tab) throw new Error("no tab");
  sized(tab);
  tab.attach(container());
  tab.layout();
  await vi.advanceTimersByTimeAsync(500);
  expect(webgl.made).toEqual([]);
  expect(tab.term.element).toBeUndefined();
});

test("a hidden tab goes on parsing and acknowledging what its session writes", async () => {
  const { mounted, opens, sent } = setup();
  const tab = await mounted();
  tab.setShown(false);
  await vi.advanceTimersByTimeAsync(10);
  opens[0]?.send({ state: "running" });
  opens[0]?.send(bytes("while hidden\r\n"));
  await vi.advanceTimersByTimeAsync(50);
  expect(text(tab)).toContain("while hidden");
  expect(sent("shell_ack")).toEqual([{ id: 7, bytes: 14 }]);
});

test("a layout change fits the terminal once it settles, and only a new size is sent", async () => {
  const { mounted, opens, sent } = setup();
  const tab = await mounted();
  opens[0]?.send({ state: "running" });
  await vi.advanceTimersByTimeAsync(10);

  tab.layout();
  tab.layout();
  await vi.advanceTimersByTimeAsync(150);
  expect(sent("shell_resize")).toEqual([]);

  sized(tab, 400, 160);
  tab.layout();
  await vi.advanceTimersByTimeAsync(50);
  expect(sent("shell_resize")).toEqual([]);
  tab.layout();
  await vi.advanceTimersByTimeAsync(150);
  expect(sent("shell_resize")).toEqual([{ id: 7, cols: 48, rows: 10 }]);

  tab.layout();
  await vi.advanceTimersByTimeAsync(150);
  expect(sent("shell_resize")).toHaveLength(1);
});

test("typed keys and pastes go to the session in bytes, and the keys of a bound chord stay with the workbench", async () => {
  const { mounted, opens, sent, binds } = setup({ binds: true });
  const tab = await mounted();
  opens[0]?.send({ state: "running" });
  await vi.advanceTimersByTimeAsync(10);
  const textarea = tab.term.textarea;
  if (!textarea) throw new Error("no textarea");
  textarea.dispatchEvent(enter());
  await vi.advanceTimersByTimeAsync(10);
  expect(sent("shell_input")).toEqual([{ id: 7, data: [13] }]);
  expect(binds).not.toHaveBeenCalled();

  textarea.dispatchEvent(enter({ metaKey: true }));
  await vi.advanceTimersByTimeAsync(10);
  expect(binds).toHaveBeenCalledOnce();
  expect(sent("shell_input")).toHaveLength(1);

  tab.term.paste("héllo\nwörld");
  await vi.advanceTimersByTimeAsync(10);
  expect(sent("shell_input")[1]).toEqual({
    id: 7,
    data: Array.from(new TextEncoder().encode("héllo\rwörld")),
  });
});

test("keys typed while the shell connects go to it, and none while it waits for a place", async () => {
  const { mounted, opens, sent } = setup();
  const tab = await mounted();
  const textarea = tab.term.textarea;
  if (!textarea) throw new Error("no textarea");
  expect(tab.getStatus()).toEqual({ state: "connecting" });
  textarea.dispatchEvent(enter());
  await vi.advanceTimersByTimeAsync(10);
  expect(sent("shell_input")).toEqual([{ id: 7, data: [13] }]);

  opens[0]?.send({ state: "queued" });
  textarea.dispatchEvent(enter());
  await vi.advanceTimersByTimeAsync(10);
  expect(sent("shell_input")).toHaveLength(1);
});

test("a chord that is not a binding reaches the terminal", async () => {
  const { mounted, opens, sent, binds } = setup({ binds: false });
  const tab = await mounted();
  opens[0]?.send({ state: "running" });
  await vi.advanceTimersByTimeAsync(10);
  tab.term.textarea?.dispatchEvent(enter({ metaKey: true }));
  await vi.advanceTimersByTimeAsync(10);
  expect(binds).toHaveBeenCalledOnce();
  expect(sent("shell_input")).toEqual([{ id: 7, data: [13] }]);
});

test("a paste goes in brackets while the shell asks for them", async () => {
  const { mounted, opens, sent } = setup();
  const tab = await mounted();
  opens[0]?.send({ state: "running" });
  opens[0]?.send(bytes("\x1b[?2004h"));
  await vi.advanceTimersByTimeAsync(10);
  tab.term.textarea?.dispatchEvent(
    Object.assign(new Event("paste", { bubbles: true, cancelable: true }), {
      clipboardData: { getData: () => "one\ntwo" },
    }),
  );
  await vi.advanceTimersByTimeAsync(10);
  expect(sent("shell_input")).toEqual([
    {
      id: 7,
      data: Array.from(new TextEncoder().encode("\x1b[200~one\rtwo\x1b[201~")),
    },
  ]);
});

test.each<[ShellEnd, string]>([
  [{ reason: "exited", code: 0 }, "Session ended."],
  [{ reason: "exited", code: 3 }, "Session ended with exit code 3."],
  [
    { reason: "noShell", message: "OCI runtime exec failed: no sh" },
    "This container has no shell.\nOCI runtime exec failed: no sh",
  ],
  [
    {
      reason: "failed",
      error: { kind: "notFound", message: "pod api-0 is gone" },
    },
    "pod api-0 is gone",
  ],
  [
    { reason: "connectionLost" },
    "The connection was lost. A shell cannot be resumed.",
  ],
  [{ reason: "detached" }, "The attach ended."],
  [{ reason: "relocked" }, "The context became read-only."],
])(
  "%o ends the tab with its words once in the scrollback, and the input off",
  async (end, words) => {
    const { mounted, opens } = setup();
    const tab = await mounted();
    opens[0]?.send({ state: "running" });
    opens[0]?.send(bytes("output\r\n"));
    opens[0]?.send({ state: "ended", end });
    await vi.advanceTimersByTimeAsync(50);
    const scrollback = text(tab);
    expect(scrollback).toContain(`output\n\n${words}`);
    expect(scrollback.split(words).length).toBe(2);
    expect(tab.getStatus()).toEqual({ state: "ended", end });
    expect(tab.term.options.disableStdin).toBe(true);
    expect(tab.live).toBe(false);
  },
);

test("a session that ends in the alternate screen leaves it for the words, and one that does not keeps its cursor", async () => {
  const { mounted, opens } = setup();
  const tab = await mounted();
  opens[0]?.send({ state: "running" });
  opens[0]?.send(bytes("plain\r\n"));
  opens[0]?.send({ state: "ended", end: { reason: "exited", code: 0 } });
  await vi.advanceTimersByTimeAsync(50);
  expect(text(tab).split("\n").slice(0, 3)).toEqual([
    "plain",
    "",
    "Session ended.",
  ]);

  const other = setup();
  const alternate = await other.mounted();
  other.opens[0]?.send({ state: "running" });
  other.opens[0]?.send(bytes("\x1b[?1049hvim"));
  other.opens[0]?.send({ state: "ended", end: { reason: "exited", code: 1 } });
  await vi.advanceTimersByTimeAsync(50);
  expect(alternate.term.buffer.active.type).toBe("normal");
});

test("a restart closes what ended, opens a new session at the terminal's size and keeps the scrollback", async () => {
  const { mounted, opens, sent, tabs } = setup();
  const tab = await mounted();
  opens[0]?.send({ state: "running" });
  opens[0]?.send(bytes("first\r\n"));
  opens[0]?.send({ state: "ended", end: { reason: "exited", code: 0 } });
  await vi.advanceTimersByTimeAsync(50);

  tabs.start(URI, INPUT, 8);
  await vi.advanceTimersByTimeAsync(10);
  expect(sent("shell_close")).toEqual([7]);
  expect(opens.map(({ request }) => request)).toEqual([
    { id: 7, cols: 78, rows: 20 },
    { id: 8, cols: 78, rows: 20 },
  ]);
  expect(tab.getStatus()).toEqual({ state: "connecting" });
  expect(tab.term.options.disableStdin).toBe(false);
  expect(text(tab)).toContain("first");
  expect(tab.live).toBe(true);
});

test("a tab restored with no session says so and sends nothing, whatever shows", async () => {
  const { tabs, calls, container } = setup();
  const tab = tabs.tab(URI, INPUT);
  expect(tab.getStatus()).toEqual({ state: "restored" });
  sized(tab);
  tab.attach(container());
  tab.setShown(true);
  await vi.advanceTimersByTimeAsync(1000);
  tab.layout();
  await vi.advanceTimersByTimeAsync(1000);
  expect(calls).toEqual([]);
  expect(tab.live).toBe(false);
});

test("closing a tab closes its session and its terminal, and one never opened too", async () => {
  const { tabs, sent, mounted, container } = setup();
  const tab = await mounted();
  tabs.closed(URI);
  expect(sent("shell_close")).toEqual([7]);
  expect(tabs.has(URI)).toBe(false);
  expect(tab.host.isConnected).toBe(false);

  tabs.start(URI, INPUT, 9);
  container();
  tabs.closed(URI);
  expect(sent("shell_close")).toEqual([7, 9]);
});

test("a session that waits is live, and the tab says it queued", async () => {
  const { mounted, opens } = setup();
  const tab = await mounted();
  opens[0]?.send({ state: "queued" });
  expect(tab.getStatus()).toEqual({ state: "queued" });
  expect(tab.live).toBe(true);
});

test("a link opens only on a modifier click, and only as http or https", async () => {
  const { mounted, openUrl } = setup();
  const tab = await mounted();
  const linkHandler = tab.term.options.linkHandler;
  const click = (text: string, init: MouseEventInit) => {
    linkHandler?.activate(new MouseEvent("click", init), text, {
      start: { x: 1, y: 1 },
      end: { x: 2, y: 1 },
    });
  };
  click("https://example.com/a", {});
  click("https://example.com/a", { ctrlKey: true });
  expect(openUrl).not.toHaveBeenCalled();
  click("https://example.com/a", { metaKey: true });
  click("http://localhost:8080", { metaKey: true });
  click("javascript:alert(1)", { metaKey: true });
  click("file:///etc/passwd", { metaKey: true });
  click("not a url", { metaKey: true });
  expect(openUrl.mock.calls).toEqual([
    ["https://example.com/a"],
    ["http://localhost:8080"],
  ]);
});

test("the theme follows the document's tokens as the app toggles its theme", async () => {
  const { mounted } = setup();
  document.documentElement.style.setProperty("--editor", "first");
  const tab = await mounted();
  expect(tab.term.options.theme?.background).toBe("first");
  document.documentElement.style.setProperty("--editor", "second");
  document.documentElement.classList.toggle("dark");
  await vi.advanceTimersByTimeAsync(10);
  expect(tab.term.options.theme?.background).toBe("second");
  document.documentElement.classList.remove("dark");
});

test("a terminal keeps 5000 lines", async () => {
  const { mounted, opens } = setup();
  const tab = await mounted();
  opens[0]?.send({ state: "running" });
  opens[0]?.send(bytes("x\r\n".repeat(9000)));
  await vi.advanceTimersByTimeAsync(200);
  expect(tab.term.buffer.active.length).toBe(5000 + tab.term.rows);
});

test("a copy takes the selection through the copy event, and nothing without one", async () => {
  const { mounted, opens } = setup();
  const tab = await mounted();
  opens[0]?.send({ state: "running" });
  opens[0]?.send(bytes("hello world\r\n"));
  await vi.advanceTimersByTimeAsync(50);
  const copy = () => {
    const setData = vi.fn();
    tab.term.element?.dispatchEvent(
      Object.assign(new Event("copy", { bubbles: true, cancelable: true }), {
        clipboardData: { setData },
      }),
    );
    return setData;
  };
  expect(copy()).not.toHaveBeenCalled();
  tab.term.select(0, 0, 5);
  expect(copy()).toHaveBeenCalledWith("text/plain", "hello");
});

test("a finished tab keeps its scrollback to read and select", async () => {
  const { mounted, opens } = setup();
  const tab = await mounted();
  opens[0]?.send({ state: "running" });
  opens[0]?.send(bytes("kept line\r\n"));
  opens[0]?.send({ state: "ended", end: { reason: "exited", code: 0 } });
  await vi.advanceTimersByTimeAsync(50);
  tab.term.selectAll();
  expect(tab.term.hasSelection()).toBe(true);
  expect(tab.term.getSelection()).toContain("kept line");
  expect(tab.term.getSelection()).toContain("Session ended.");
});

test("a program's mouse and paste modes end with its session, so the text can be selected", async () => {
  const { mounted, opens } = setup();
  const tab = await mounted();
  opens[0]?.send({ state: "running" });
  opens[0]?.send(bytes("\x1b[?1000h\x1b[?1006h\x1b[?2004h"));
  await vi.advanceTimersByTimeAsync(50);
  expect(tab.term.modes.mouseTrackingMode).toBe("vt200");
  expect(tab.term.modes.bracketedPasteMode).toBe(true);
  opens[0]?.send({ state: "ended", end: { reason: "connectionLost" } });
  await vi.advanceTimersByTimeAsync(50);
  expect(tab.term.modes.mouseTrackingMode).toBe("none");
  expect(tab.term.modes.bracketedPasteMode).toBe(false);
});
