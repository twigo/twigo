import {
  LogsSession,
  type Backend,
  type LogSource,
  type LogTarget,
  type LogView,
} from "@twigo/protocol";
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
  /** A field asked to take the focus and has not yet. */
  readonly focus: "filter" | "search" | undefined;
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
  focus: undefined,
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
  /** Each tab's pods as it first listed them, so the pods that join later stand out. */
  readonly #first = new Map<string, ReadonlySet<string>>();

  constructor(private readonly backend: Backend) {}

  get(uri: string): LogsTab {
    return this.#tabs.get(uri) ?? INITIAL;
  }

  /** What a tab opens with, set before it opens: Previous logs picks the container and its previous instance. */
  prepare(uri: string, source: Partial<LogSource>): void {
    this.update(uri, { source: { ...this.get(uri).source, ...source } });
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

  setView(uri: string, change: Partial<LogView>): void {
    const tab = this.get(uri);
    const searched =
      change.search !== undefined && change.search !== tab.view.search;
    this.update(uri, {
      view: { ...tab.view, ...change },
      ...(searched && { current: 0 }),
    });
  }

  setSource(uri: string, change: Partial<LogSource>): void {
    this.update(uri, { source: { ...this.get(uri).source, ...change } });
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

  /** Keeps the pods a tab first lists. */
  listed(uri: string, pods: readonly { name: string }[]): void {
    if (!this.#first.has(uri))
      this.#first.set(uri, new Set(pods.map((pod) => pod.name)));
  }

  /** Whether a pod joined the tab after it first listed its pods, as a rollout's new pods do. */
  joined(uri: string, pod: string): boolean {
    const first = this.#first.get(uri);
    return first !== undefined && !first.has(pod);
  }

  focus(uri: string, field: "filter" | "search"): void {
    this.update(uri, { focus: field });
  }

  focused(uri: string): void {
    if (this.get(uri).focus !== undefined)
      this.update(uri, { focus: undefined });
  }

  closed(uri: string): void {
    this.#sessions.get(uri)?.close();
    this.#sessions.delete(uri);
    this.#first.delete(uri);
    if (this.#tabs.delete(uri)) this.changes.emit();
  }
}
