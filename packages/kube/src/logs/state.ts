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
import { currentMatch, standingMatch } from "./entries";

/** What a logs tab shows (ARCHITECTURE 4.6); its lines live in Rust. */
export interface LogsTab {
  readonly source: LogSource;
  readonly view: LogView;
  readonly follow: boolean;
  readonly wrap: boolean;
  readonly timestamps: boolean;
  /**
   * The entry and the mark the current match is, by the entry's id and its
   * place counted from the line's last mark, once the person stepped to it:
   * matches that come or go around it move its number, not the match; the
   * newest match until then.
   */
  readonly anchor: MatchAnchor | undefined;
  /**
   * The entry the last step went to, by its id, and a token each step
   * changes: the list scrolls to it on a step, not as lines come, and not
   * again when it mounts anew, whatever the search shows since.
   */
  readonly reveal: { readonly id: number; readonly token: number } | undefined;
  /** A step to an older match, or a newer one, asked before Rust applied the search it follows: done once it has. */
  readonly waiting: "older" | "newer" | undefined;
  /** The view's `arrived` when the list paused, and the changes Rust had applied then, from which it counts the lines that came since. */
  readonly pausedAt: { readonly changes: number; readonly arrived: number };
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
  anchor: undefined,
  reveal: undefined,
  waiting: undefined,
  pausedAt: { changes: 0, arrived: 0 },
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

  /**
   * A new search has other matches, so it starts again from the newest; a
   * filter, level or range keeps the match stepped to while the view keeps
   * it, and while Rust refuses the view. A paused list keeps its place, which
   * a remount seeks, where its time puts it if the view hides its line.
   */
  setView(uri: string, change: Partial<LogView>): void {
    const tab = this.get(uri);
    const view = { ...tab.view, ...change };
    if (same(view, tab.view)) return;
    this.update(uri, {
      view,
      ...(view.search !== tab.view.search && { anchor: undefined }),
    });
  }

  /** A new source reads the buffer anew, so the list follows its end. */
  setSource(uri: string, change: Partial<LogSource>): void {
    const tab = this.get(uri);
    const source = { ...tab.source, ...change };
    if (same(source, tab.source)) return;
    this.#places.delete(uri);
    this.update(uri, {
      source,
      anchor: undefined,
      follow: true,
    });
  }

  /** Follows the end, or pauses, counting the lines that come from what the view kept until now. */
  follow(uri: string, follow: boolean): void {
    const tab = this.get(uri);
    if (tab.follow === follow) return;
    if (follow) this.#places.delete(uri);
    this.update(uri, { follow, ...(!follow && { pausedAt: this.#now(uri) }) });
  }

  /**
   * The lines that came since the list paused: counted from the pause
   * while Rust applies the changes it had then; after a change, every line
   * the new view kept, since all of them came after the pause.
   */
  fresh(uri: string): number {
    const snapshot = this.#sessions.get(uri)?.getSnapshot();
    if (!snapshot) return 0;
    const { pausedAt } = this.get(uri);
    return snapshot.changes === pausedAt.changes
      ? Math.max(0, snapshot.arrived - pausedAt.arrived)
      : snapshot.arrived;
  }

  #now(uri: string): LogsTab["pausedAt"] {
    const snapshot = this.#sessions.get(uri)?.getSnapshot();
    return {
      changes: snapshot?.changes ?? 0,
      arrived: snapshot?.arrived ?? 0,
    };
  }

  place(uri: string): LinePlace | undefined {
    return this.#places.get(uri);
  }

  /** Keeps where a paused list stands; nothing redraws for it. */
  keepPlace(uri: string, place: LinePlace): void {
    this.#places.set(uri, place);
  }

  /**
   * Steps the search to the next older or newer match and scrolls to it,
   * which pauses following; asked before Rust applied the search, it waits
   * for that search's matches. From a match older than the 10,000 listed it
   * goes on from the oldest listed: newer to that one, older round to the
   * newest.
   */
  step(uri: string, older: boolean): void {
    const snapshot = this.#sessions.get(uri)?.getSnapshot();
    if (!snapshot) return;
    const tab = this.get(uri);
    if (!snapshot.settled) {
      this.update(uri, { waiting: older ? "older" : "newer" });
      return;
    }
    const shown = snapshot.matches?.entries.length ?? 0;
    if (shown === 0) {
      if (tab.waiting) this.update(uri, { waiting: undefined });
      return;
    }
    // Counted back from the newest, an older match is a larger one.
    const standing = standingMatch(snapshot.matches, tab.anchor);
    const back = standing?.atMost
      ? older
        ? 0
        : shown - 1
      : ((standing?.back ?? 0) + (older ? 1 : shown - 1)) % shown;
    const next = currentMatch(snapshot.matches, back);
    this.update(uri, {
      anchor: next && { id: next.id, fromEnd: next.fromEnd },
      reveal: next && { id: next.id, token: (tab.reveal?.token ?? 0) + 1 },
      waiting: undefined,
      follow: false,
      ...(tab.follow && { pausedAt: this.#now(uri) }),
    });
  }

  /** The tab's session, opened the first time a tab asks for it. */
  session(uri: string, target: LogTarget): LogsSession {
    let session = this.#sessions.get(uri);
    if (!session) {
      const { source, view } = this.get(uri);
      const opened = new LogsSession(this.backend, { target, source, view });
      opened.subscribe(() => {
        const { waiting } = this.get(uri);
        if (waiting && opened.getSnapshot().settled)
          this.step(uri, waiting === "older");
      });
      this.#sessions.set(uri, opened);
      session = opened;
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

/** The choices are plain data, so their JSON tells them apart. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
