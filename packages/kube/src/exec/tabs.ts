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
import { Changes, type Platform } from "@twigo/workbench";
import type { ExecInput } from "../uri";
import { terminalFont, terminalTheme } from "./theme";
import { ending } from "./words";

/** The lines a terminal keeps (ARCHITECTURE 4.6). */
const SCROLLBACK = 5000;

/** How long a layout change waits for the next one before the terminal is fitted. */
const FIT_MS = 100;

/** The modes a program leaves on: the mouse, bracketed paste, and the cursor, hidden while the input is off. */
const MODES_OFF =
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25l";
/** Leaves the alternate screen, which restores the cursor: a terminal that is not on it would jump home. */
const LEAVE_ALTERNATE = "\x1b[?1049l";
/**
 * A soft reset (DECSTR): the cursor and keypad keys, focus reporting, wrapping,
 * insert and origin modes, and the cursor shown. The screen and the scrollback
 * stay; the mouse and bracketed paste it leaves are `MODES_OFF`'s.
 */
const SOFT_RESET = "\x1b[!p";
const SESSION_STARTS = `${MODES_OFF}${SOFT_RESET}`;

/** The logs' bright black, for words that are not the process's. */
const QUIET = "\x1b[90m";
const PLAIN = "\x1b[0m";

const encoder = new TextEncoder();

/** None for a tab restored from the saved layout. */
export type ExecStatus = ShellEvent | { readonly state: "restored" };

export interface ExecOptions {
  readonly backend: Backend;
  readonly platform: Platform;
  readonly report: (error: unknown) => void;
  readonly openUrl: (url: string) => void;
  /** Whether a key press is a binding of the workbench, which the terminal gives up. */
  readonly binds: (event: KeyboardEvent) => boolean;
  /** The WebGL renderer of a terminal; a test brings another, as jsdom has no WebGL. */
  readonly webgl?: () => WebglRenderer;
}

export interface WebglRenderer extends ITerminalAddon {
  readonly onContextLoss: (listener: () => void) => IDisposable;
}

/**
 * One shell tab (ARCHITECTURE 4.6). The terminal and its element belong to
 * the tab, not to the view: a view moves the element in when it mounts, so
 * a tab moved to another group or hidden with the panel loses nothing, and
 * the session goes on writing to the terminal meanwhile.
 */
export class ExecTab {
  readonly host = document.createElement("div");
  readonly term: Terminal;
  readonly #options: ExecOptions;
  readonly #changed: () => void;
  readonly #fit = new FitAddon();
  #status: ExecStatus;
  /** A session the plan's run answered with, not yet opened with the terminal's size. */
  #pending: SubscriptionId | undefined;
  #session: ShellSession | undefined;
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
    readonly input: ExecInput,
    options: ExecOptions,
    changed: () => void,
    session: SubscriptionId | undefined,
  ) {
    this.#options = options;
    this.#changed = changed;
    this.#pending = session;
    this.#status =
      session === undefined ? { state: "restored" } : { state: "connecting" };
    this.host.className = "size-full overflow-hidden pt-1 pl-2";
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
      (event) =>
        !(event.type === "keydown" && event.metaKey && options.binds(event)),
    );
  }

  getStatus(): ExecStatus {
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
   * and given up after the task that hid the tab, since doing it in that
   * task made the browser measure the terminal again for every row.
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

  focus(): void {
    if (this.#opened) this.term.focus();
    else this.#focusWanted = true;
  }

  /** The renderer in use, for a test. */
  get renderer(): "webgl" | "dom" {
    return this.#webgl ? "webgl" : "dom";
  }

  /** Starts, or starts again after an ending, with the session a plan's run answered with. */
  start(session: SubscriptionId): void {
    this.#release();
    this.#pending = session;
    this.#status = { state: "connecting" };
    this.term.options.disableStdin = false;
    this.term.write(SESSION_STARTS);
    this.#changed();
    this.#begin();
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
      return;
    }
    this.term.open(this.host);
    this.#opened = true;
    this.#fit.fit();
    this.#loadWebgl();
    this.#begin();
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

  #sync(next: ShellEvent): void {
    const was = this.#status.state;
    this.#status = next;
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

/**
 * Each shell tab's terminal and session, by the tab's URI, so a tab that
 * mounts again, as panel tabs do when they show, keeps its terminal; they
 * end when the tab closes (ARCHITECTURE 4.6).
 */
export class ExecTabs {
  readonly changes = new Changes();
  readonly #tabs = new Map<string, ExecTab>();
  readonly #observer: MutationObserver;

  constructor(private readonly options: ExecOptions) {
    // The theme follows the document's: the app toggles `dark` on its root.
    this.#observer = new MutationObserver(() => {
      for (const tab of this.#tabs.values()) {
        tab.term.options.theme = terminalTheme();
      }
    });
    this.#observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  has(uri: string): boolean {
    return this.#tabs.has(uri);
  }

  get(uri: string): ExecTab | undefined {
    return this.#tabs.get(uri);
  }

  list(): readonly (readonly [string, ExecTab])[] {
    return [...this.#tabs];
  }

  /**
   * The tab of a URI; one the layout restored has no session and says so. A
   * view asks for it as it renders, so the change it makes is told once the
   * render is done.
   */
  tab(uri: string, input: ExecInput): ExecTab {
    const found = this.#tabs.get(uri);
    if (found) return found;
    const made = this.#make(uri, input, undefined);
    queueMicrotask(() => {
      this.changes.emit();
    });
    return made;
  }

  start(uri: string, input: ExecInput, session: SubscriptionId): void {
    const found = this.#tabs.get(uri);
    if (found) found.start(session);
    else this.#make(uri, input, session);
    this.changes.emit();
  }

  closed(uri: string): void {
    const tab = this.#tabs.get(uri);
    if (!tab) return;
    this.#tabs.delete(uri);
    tab.dispose();
    this.changes.emit();
  }

  #make(
    uri: string,
    input: ExecInput,
    session: SubscriptionId | undefined,
  ): ExecTab {
    const tab = new ExecTab(
      input,
      this.options,
      () => {
        this.changes.emit();
      },
      session,
    );
    this.#tabs.set(uri, tab);
    return tab;
  }
}
