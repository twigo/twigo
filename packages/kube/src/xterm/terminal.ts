import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type IDisposable, type ITerminalAddon } from "@xterm/xterm";
import {
  ShellSession,
  type Backend,
  type ShellEvent,
  type SubscriptionId,
} from "@twigo/protocol";
import type { Platform } from "@twigo/workbench";
import { terminalFont, terminalTheme } from "./theme";
import { ending } from "./words";

/** The lines a terminal keeps (ARCHITECTURE 4.6). */
const SCROLLBACK = 5000;

/** How long a layout change waits for the next one before the terminal is fitted. */
const FIT_MS = 100;

/**
 * The modes a program leaves on: the mouse, bracketed paste and focus
 * reporting, and the cursor, hidden while the input is off. Written when a
 * session ends too, since a restart's reset is parsed after the task that
 * focuses the terminal, which would report the focus to the new shell.
 */
const CURSOR_OFF = "\x1b[?25l";
const MODES_OFF = `\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1006l\x1b[?2004l${CURSOR_OFF}`;
/** Leaves the alternate screen, which restores the cursor: a terminal that is not on it would jump home. */
const LEAVE_ALTERNATE = "\x1b[?1049l";
/**
 * A soft reset (DECSTR): the cursor and keypad keys, bracketed paste, focus
 * reporting, wrapping, insert and origin modes, and the cursor shown
 * ([`CoreService.reset`](https://github.com/xtermjs/xterm.js/blob/c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2/src/common/services/CoreService.ts#L68-L72)).
 * The screen and the scrollback stay, and so does the mouse, which is
 * `MODES_OFF`'s.
 */
const SOFT_RESET = "\x1b[!p";
const SESSION_STARTS = `${MODES_OFF}${SOFT_RESET}`;

/** The logs' bright black, for words that are not the process's. */
const QUIET = "\x1b[90m";
const PLAIN = "\x1b[0m";

const encoder = new TextEncoder();

/** None for a tab restored from the saved layout. */
export type SessionStatus = ShellEvent | { readonly state: "restored" };

/** A session a plan's run or `terminal_create` answered with, and how it joins its process. */
export interface SessionStart {
  readonly id: SubscriptionId;
  /** Whether the process has a terminal; without one, its line feeds come with no carriage return. */
  readonly tty: boolean;
  /** Whether what is typed reaches the process. */
  readonly stdin: boolean;
}

export interface TerminalOptions {
  readonly backend: Backend;
  readonly platform: Platform;
  readonly report: (error: unknown) => void;
  readonly openUrl: (url: string) => void;
  /** Whether the workbench takes a key press, which the terminal then gives up. */
  readonly binds: (event: KeyboardEvent) => boolean;
  /** The WebGL renderer of a terminal; a test brings another, as jsdom has no WebGL. */
  readonly webgl?: () => WebglRenderer;
}

export interface WebglRenderer extends ITerminalAddon {
  readonly onContextLoss: (listener: () => void) => IDisposable;
}

/**
 * What a shell tab and a terminal tab own of xterm (ARCHITECTURE 4.6). The
 * terminal and its element belong to the tab, not to the view: a view moves
 * the element in when it mounts, so a tab moved to another group or hidden
 * with the panel loses nothing, and the session goes on writing to the
 * terminal meanwhile.
 */
export class ShellTerminal {
  readonly host = document.createElement("div");
  readonly term: Terminal;
  readonly #options: TerminalOptions;
  readonly #changed: () => void;
  readonly #fit = new FitAddon();
  #status: SessionStatus;
  /** A session the plan's run answered with, not yet opened with the terminal's size. */
  #pending: SubscriptionId | undefined;
  #session: ShellSession | undefined;
  #stdin = true;
  #unsubscribe: (() => void) | undefined;
  #opened = false;
  #shown = false;
  #focusWanted = false;
  /** WebGL failed to load or lost its context: this terminal stays on the DOM renderer. */
  #software = false;
  #webgl: WebglRenderer | undefined;
  #unload: ReturnType<typeof setTimeout> | undefined;
  #fitTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    options: TerminalOptions,
    changed: () => void,
    session: SessionStart | undefined,
  ) {
    this.#options = options;
    this.#changed = changed;
    this.#pending = session?.id;
    this.#status =
      session === undefined ? { state: "restored" } : { state: "connecting" };
    this.host.className = "size-full overflow-hidden";
    this.term = new Terminal({
      allowProposedApi: true,
      scrollback: SCROLLBACK,
      cursorBlink: true,
      fontSize: 12,
      fontFamily: terminalFont(),
      theme: terminalTheme(),
      linkHandler: {
        activate: (event, text) => {
          const modifier =
            options.platform === "mac" ? event.metaKey : event.ctrlKey;
          if (modifier && isWebLink(text)) options.openUrl(text);
        },
      },
    });
    this.term.loadAddon(this.#fit);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    this.term.onData((data) => {
      this.#session?.input(encoder.encode(data));
    });
    this.term.onBinary((data) => {
      this.#session?.input(Uint8Array.from(data, (char) => char.charCodeAt(0)));
    });
    this.term.onResize(({ cols, rows }) => {
      this.#session?.resize(cols, rows);
    });
    this.term.attachCustomKeyEventHandler(
      (event) => !(event.type === "keydown" && options.binds(event)),
    );
    if (session) this.#join(session);
  }

  getStatus(): SessionStatus {
    return this.#status;
  }

  get live(): boolean {
    return this.#status.state !== "ended" && this.#status.state !== "restored";
  }

  attach(container: HTMLElement): void {
    if (this.host.parentElement !== container) container.append(this.host);
  }

  /**
   * Whether the tab is on screen: not behind another tab, not under a
   * maximized panel, not in a hidden one. WebGL is held only while it is,
   * and given up after the task that hid the tab, so a tab hidden and shown
   * again in one task keeps its context.
   */
  setShown(shown: boolean): void {
    if (shown === this.#shown) return;
    this.#shown = shown;
    clearTimeout(this.#unload);
    if (shown) {
      this.#fitNow();
      this.#loadWebgl();
    } else {
      this.#unload = setTimeout(() => {
        this.#dropWebgl();
      }, 0);
    }
  }

  /** Fits the terminal to its container once the layout has held still for a moment. */
  layout(): void {
    clearTimeout(this.#fitTimer);
    this.#fitTimer = setTimeout(() => {
      this.#fitNow();
    }, FIT_MS);
  }

  /** A view puts the terminal on the page after the focus is asked for, so the focus waits for it. */
  focus(): void {
    if (this.#opened && this.host.isConnected) this.term.focus();
    else this.#focusWanted = true;
  }

  /** The renderer in use, for a test. */
  get renderer(): "webgl" | "dom" {
    return this.#webgl ? "webgl" : "dom";
  }

  /**
   * Starts, or starts again, with the session a plan's run answered with. A
   * terminal whose cursor is not at the start of a line, as when a running
   * session is replaced, gives the new session a line of its own: zsh marks
   * a prompt that does not start one with an inverse `%`.
   */
  start(session: SessionStart): void {
    this.#release();
    this.#pending = session.id;
    this.#status = { state: "connecting" };
    // The cursor is known once the output so far is parsed, and the session opens after the line feed, so that none of its output comes before.
    this.term.write(SESSION_STARTS, () => {
      if (this.#pending !== session.id) return;
      if (this.term.buffer.active.cursorX > 0) this.term.write("\r\n");
      this.#begin();
    });
    this.#join(session);
    this.#changed();
  }

  /**
   * A process with no terminal writes bare line feeds, which a terminal
   * would draw as a staircase, so they come with carriage returns; one
   * that keeps no stdin takes no input, and its cursor is hidden.
   */
  #join({ tty, stdin }: SessionStart): void {
    this.#stdin = stdin;
    this.term.options.convertEol = !tty;
    this.term.options.disableStdin = !stdin;
    if (!stdin) this.term.write(CURSOR_OFF);
  }

  dispose(): void {
    clearTimeout(this.#unload);
    clearTimeout(this.#fitTimer);
    this.#release();
    this.#dropWebgl();
    this.term.dispose();
    this.host.remove();
  }

  /** Closes the session, or the one never opened, so Rust frees its place. */
  #release(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#session?.close();
    this.#session = undefined;
    if (this.#pending !== undefined) {
      this.#options.backend
        .invoke("shell_close", this.#pending)
        .catch(this.#options.report);
      this.#pending = undefined;
    }
  }

  #fitNow(): void {
    if (
      !this.#shown ||
      !this.host.isConnected ||
      this.host.offsetWidth === 0 ||
      this.host.offsetHeight === 0
    ) {
      return;
    }
    if (this.#opened) {
      this.#fit.fit();
    } else {
      this.term.open(this.host);
      this.#opened = true;
      this.#fit.fit();
      this.#loadWebgl();
      this.#begin();
    }
    if (this.#focusWanted) {
      this.#focusWanted = false;
      this.term.focus();
    }
  }

  /** The first size goes in `shell_open`, so the session opens once the terminal is mounted and fitted. */
  #begin(): void {
    const id = this.#pending;
    if (id === undefined || !this.#opened) return;
    this.#pending = undefined;
    const session = new ShellSession(
      this.#options.backend,
      { id, cols: this.term.cols, rows: this.term.rows },
      (bytes, parsed) => {
        this.term.write(bytes, parsed);
      },
      this.#options.report,
    );
    this.#session = session;
    this.#unsubscribe = session.subscribe(() => {
      this.#sync(session.getSnapshot());
    });
  }

  /** What the scrollback says once the session runs, before the process's output. */
  protected runningWords(_stdin: boolean): string | undefined {
    return undefined;
  }

  #sync(next: ShellEvent): void {
    const was = this.#status.state;
    this.#status = next;
    if (next.state === "running" && was !== "running") {
      const words = this.runningWords(this.#stdin);
      if (words !== undefined) this.term.write(`${QUIET}${words}${PLAIN}\r\n`);
    }
    if (next.state === "ended" && was !== "ended") {
      const { title, detail } = ending(next.end);
      const lines = [title, ...(detail?.split(/\r?\n/) ?? [])];
      this.term.options.disableStdin = true;
      // Once the output is parsed, so that it is known whether a program is on the alternate screen.
      this.term.write("", () => {
        const leave =
          this.term.buffer.active.type === "alternate" ? LEAVE_ALTERNATE : "";
        this.term.write(
          `${leave}${MODES_OFF}\r\n${QUIET}${lines.join("\r\n")}${PLAIN}\r\n`,
        );
      });
    }
    this.#changed();
  }

  #loadWebgl(): void {
    if (!this.#opened || !this.#shown || this.#webgl || this.#software) return;
    try {
      const renderer = this.#options.webgl?.() ?? new WebglAddon();
      this.term.loadAddon(renderer);
      renderer.onContextLoss(() => {
        this.#software = true;
        this.#dropWebgl();
      });
      this.#webgl = renderer;
    } catch {
      this.#software = true;
    }
  }

  #dropWebgl(): void {
    this.#webgl?.dispose();
    this.#webgl = undefined;
  }
}

/** An OSC 8 link opens only as `http` or `https`; anything else, such as `javascript:`, does nothing. */
function isWebLink(text: string): boolean {
  try {
    const { protocol } = new URL(text);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
