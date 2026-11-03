import {
  LogsSession,
  type Backend,
  type LogEntry,
  type LogSource,
  type LogTarget,
  type LogView,
} from "@twigo/protocol";
import type { LinePlace } from "@twigo/ui";
import { Changes } from "@twigo/workbench";

/** What a logs tab shows (ARCHITECTURE 4.6); its lines live in Rust. */
export interface LogsTab {
  readonly source: LogSource;
  readonly view: LogView;
  readonly follow: boolean;
  readonly wrap: boolean;
  readonly timestamps: boolean;
  /** The match the search stands on, counted back from the newest: 0 is the last. */
  readonly current: number;
  /**
   * The entry and the mark the current match is, by the entry's id and its
   * place counted from the line's last mark, once the person stepped to it:
   * matches that come or go around it move `current`, not the match.
   */
  readonly anchor: MatchAnchor | undefined;
  /** Counts the steps, so the list scrolls to the current match on a step and not as lines come. */
  readonly steps: number;
  /** The view's `arrived` when the list paused, from which it counts the lines that came since. */
  readonly pausedAt: number;
  /** A field asked to take the focus and has not yet. */
  readonly focus: "filter" | "search" | undefined;
  /** A narrow tab's row of fields is open, once a key or its icon asked for a field. */
  readonly fields: boolean;
}

export interface MatchAnchor {
  readonly id: number;
  readonly fromEnd: number;
}

/** The containers a tab follows at once (ARCHITECTURE 4.6); Rust holds the rest back. */
export const TAB_STREAMS = 10;

/** The last 15 minutes of each pod's default container (ARCHITECTURE 4.6). */
export const DEFAULT_SOURCE: LogSource = {
  containers: { type: "default" },
  pods: null,
  since: { type: "seconds", seconds: 900 },
  previous: false,
};

export const DEFAULT_VIEW: LogView = {
  level: "all",
  filter: null,
  search: null,
  range: null,
};

const INITIAL: LogsTab = {
  source: DEFAULT_SOURCE,
  view: DEFAULT_VIEW,
  follow: true,
  wrap: false,
  timestamps: true,
  current: 0,
  anchor: undefined,
  steps: 0,
  pausedAt: 0,
  focus: undefined,
  fields: false,
};

/**
 * Each logs tab's choices and its session in Rust, by the tab's URI, so a
 * tab that mounts again, as panel tabs do when they show, keeps its lines;
 * the session ends when the tab closes.
 */
export class LogsTabs {
  readonly changes = new Changes();
  readonly #tabs = new Map<string, LogsTab>();
  readonly #sessions = new Map<string, LogsSession>();
  /** Where each paused list stands, kept as it scrolls, so a tab that mounts again stands there. */
  readonly #places = new Map<string, LinePlace>();
  /** The pods each tab saw join, from their Joined entries, which stand out in its lines. */
  readonly #joined = new Map<string, Set<string>>();

  constructor(private readonly backend: Backend) {}

  get(uri: string): LogsTab {
    return this.#tabs.get(uri) ?? INITIAL;
  }

  /** What a tab opens with, set before it opens: Previous logs picks the container and its previous instance. */
  prepare(uri: string, source: Partial<LogSource>): void {
    this.setSource(uri, source);
  }

  update(uri: string, change: Partial<LogsTab>): void {
    const before = this.get(uri);
    const after = { ...before, ...change };
    this.#tabs.set(uri, after);
    const session = this.#sessions.get(uri);
    if (session) {
      if (after.source !== before.source) session.setSource(after.source);
      if (after.view !== before.view) session.setView(after.view);
    }
    this.changes.emit();
  }

  /** A new view or source has other matches, so the search starts again from the newest. */
  setView(uri: string, change: Partial<LogView>): void {
    const tab = this.get(uri);
    this.#places.delete(uri);
    this.update(uri, {
      view: { ...tab.view, ...change },
      current: 0,
      anchor: undefined,
      pausedAt: 0,
    });
  }

  setSource(uri: string, change: Partial<LogSource>): void {
    this.#places.delete(uri);
    this.update(uri, {
      source: { ...this.get(uri).source, ...change },
      current: 0,
      anchor: undefined,
      pausedAt: 0,
    });
  }

  /** Follows the end, or pauses, counting the lines that come from the view's `arrived` now. */
  follow(uri: string, follow: boolean): void {
    const tab = this.get(uri);
    if (tab.follow === follow) return;
    const arrived = this.#sessions.get(uri)?.getSnapshot().arrived ?? 0;
    if (follow) this.#places.delete(uri);
    this.update(uri, { follow, ...(!follow && { pausedAt: arrived }) });
  }

  place(uri: string): LinePlace | undefined {
    return this.#places.get(uri);
  }

  /** Keeps where a paused list stands; nothing redraws for it. */
  keepPlace(uri: string, place: LinePlace): void {
    this.#places.set(uri, place);
  }

  /** Steps the search to a match and scrolls to it, which pauses following. */
  step(uri: string, current: number, anchor: MatchAnchor | undefined): void {
    const tab = this.get(uri);
    const arrived = this.#sessions.get(uri)?.getSnapshot().arrived ?? 0;
    this.update(uri, {
      current,
      anchor,
      steps: tab.steps + 1,
      follow: false,
      ...(tab.follow && { pausedAt: arrived }),
    });
  }

  /** The tab's session, opened the first time a tab asks for it. */
  session(uri: string, target: LogTarget): LogsSession {
    let session = this.#sessions.get(uri);
    if (!session) {
      const { source, view } = this.get(uri);
      session = new LogsSession(this.backend, { target, source, view });
      this.#sessions.set(uri, session);
    }
    return session;
  }

  /** Keeps the pods whose Joined entries a tab's window shows. */
  saw(uri: string, entries: readonly LogEntry[]): void {
    for (const entry of entries) {
      if (entry.type !== "joined") continue;
      let joined = this.#joined.get(uri);
      if (!joined) {
        joined = new Set();
        this.#joined.set(uri, joined);
      }
      joined.add(entry.pod);
    }
  }

  /** Whether a pod joined the tab after it first listed its pods, as a rollout's new pods do. */
  joined(uri: string, pod: string): boolean {
    return this.#joined.get(uri)?.has(pod) ?? false;
  }

  focus(uri: string, field: "filter" | "search"): void {
    this.update(uri, { focus: field, fields: true });
  }

  focused(uri: string): void {
    if (this.get(uri).focus !== undefined)
      this.update(uri, { focus: undefined });
  }

  closed(uri: string): void {
    this.#sessions.get(uri)?.close();
    this.#sessions.delete(uri);
    this.#joined.delete(uri);
    this.#places.delete(uri);
    if (this.#tabs.delete(uri)) this.changes.emit();
  }
}
