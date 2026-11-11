import { Changes } from "@twigo/workbench";
import { terminalTheme } from "./theme";
import type { SessionStart, ShellTerminal } from "./terminal";

/** What the registry asks of a tab: a session to start it with, and its terminal. */
export type Tab<Session> = Pick<ShellTerminal, "term" | "dispose"> & {
  start(session: Session): void;
};

/**
 * Each tab's terminal and session by the tab's URI, so a tab that mounts
 * again, as panel tabs do when they show, keeps its terminal; they end when
 * the tab closes (ARCHITECTURE 4.6).
 */
export class ShellTabs<
  Input,
  Session extends SessionStart,
  T extends Tab<Session>,
> {
  readonly changes = new Changes();
  readonly #tabs = new Map<string, T>();
  readonly #observer: MutationObserver;

  constructor(
    private readonly create: (
      input: Input,
      changed: () => void,
      session: Session | undefined,
    ) => T,
  ) {
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

  get(uri: string): T | undefined {
    return this.#tabs.get(uri);
  }

  list(): readonly (readonly [string, T])[] {
    return [...this.#tabs];
  }

  /**
   * The tab of a URI; one the layout restored has no session and says so. A
   * view asks for it as it renders, so the change it makes is told once the
   * render is done.
   */
  tab(uri: string, input: Input): T {
    const found = this.#tabs.get(uri);
    if (found) return found;
    const made = this.#make(uri, input, undefined);
    queueMicrotask(() => {
      this.changes.emit();
    });
    return made;
  }

  start(uri: string, input: Input, session: Session): void {
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

  #make(uri: string, input: Input, session: Session | undefined): T {
    const tab = this.create(
      input,
      () => {
        this.changes.emit();
      },
      session,
    );
    this.#tabs.set(uri, tab);
    return tab;
  }
}
