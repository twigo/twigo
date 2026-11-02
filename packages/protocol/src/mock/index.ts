import type {
  Backend,
  MessageOf,
  PlainCommand,
  RequestOf,
  ResponseOf,
  SubscriptionCommand,
} from "../backend";
import { IpcError } from "../error";
import type {
  Column,
  GroupCount,
  KeyboardLayout,
  ListBatch,
  ListQuery,
  RowId,
  ShellEnvironment,
  ViewState,
} from "../generated";
import {
  AUTH_SCENARIOS,
  isAuthScenario,
  MockAuth,
  type AuthScenario,
} from "./auth";
import { Cluster, podCells, podRow, type Pod } from "./cluster";
import { CONTEXTS, NAMESPACES, POD_COUNT, SPACES, VERSIONS } from "./fixtures";
import dvorak from "./layouts/dvorak.json";
import french from "./layouts/french.json";
import german from "./layouts/german.json";
import ukrainian from "./layouts/ukrainian.json";
import us from "./layouts/us.json";
import RESOURCES from "./resources.json";
import { checkQuery, podColumns, runQuery } from "./query";

/** `live` connects, syncs and then changes pods every second; any other value pins that state. */
type ListScenario = "live" | ViewState["state"];

/**
 * A list scenario, `shellTimeout`: live lists while the login shell's
 * environment timed out, or a pinned state of prod-eu's credentials.
 */
export type MockScenario = ListScenario | "shellTimeout" | AuthScenario;

export const MOCK_SCENARIOS: readonly MockScenario[] = [
  "live",
  "shellTimeout",
  ...AUTH_SCENARIOS,
  "queued",
  "connecting",
  "syncing",
  "ready",
  "relisting",
  "stale",
  "forbidden",
  "unauthorized",
  "error",
];

/** Keyboard layouts recorded on macOS by `cargo run -p twigo-keyboard --example record`. */
export const MOCK_LAYOUTS = [
  "us",
  "ukrainian",
  "german",
  "french",
  "dvorak",
] as const;

export type MockLayout = (typeof MOCK_LAYOUTS)[number];

const LAYOUTS: Readonly<Record<MockLayout, KeyboardLayout>> = {
  us,
  ukrainian,
  german,
  french,
  dvorak,
};

/** What twigo-env reported for a `.zshrc` of `echo "Loading nvm…"; sleep 60` (2026-11-01). */
const SHELL_TIMEOUT: ShellEnvironment = {
  state: "failed",
  shell: "/bin/zsh",
  reason: "did not answer in 10 s",
  output: "Loading nvm…\n",
};

const RETRY_MS = 1500;
const FLUSH_MS = 50;
const CHURN_MS = 1000;
const RATE_TICK_MS = 100;

/**
 * Runs the UI in a plain browser on fixtures (ARCHITECTURE 2.3): spaces,
 * pods behind a query view with the same windowing and flow control as Rust,
 * and a keyboard layout that never changes.
 *
 * A live list changes pods every second, more of them where they are on
 * screen; with `changesPerSecond`, each cluster changes that many random
 * pods a second instead, counted on wall time, as the bench's churn does.
 */
export function createMockBackend(
  scenario: MockScenario = "live",
  layout: MockLayout = "us",
  changesPerSecond?: number,
): Backend {
  const now = Date.now();
  const pinsAuth = isAuthScenario(scenario);
  const lists: ListScenario =
    scenario === "shellTimeout" || isAuthScenario(scenario) ? "live" : scenario;
  const auth = new MockAuth(pinsAuth ? scenario : undefined);
  const resolved: ShellEnvironment =
    scenario === "shellTimeout" ? SHELL_TIMEOUT : { state: "resolved" };
  let environment = resolved;
  const environmentWatchers = new Set<(next: ShellEnvironment) => void>();
  const setEnvironment = (next: ShellEnvironment) => {
    environment = next;
    for (const watcher of environmentWatchers) watcher(next);
  };
  const clusters = new Map<string, Cluster>();
  const subscriptions = new Map<number, Subscription>();
  const spaces = [...SPACES];
  const appState = new Map<string, string>();
  const spaceState = new Map<string, Map<string, string>>();
  let nextId = 1;
  let churn: ReturnType<typeof setInterval> | undefined;

  const cluster = (context: string) => {
    let found = clusters.get(context);
    if (!found) {
      found = new Cluster(context, POD_COUNT[context] ?? 0, now);
      clusters.set(context, found);
    }
    return found;
  };

  const space = (id: string) => {
    const found = spaces.find((candidate) => candidate.id === id);
    if (!found) throw new IpcError("notFound", `no space ${id}`);
    return found;
  };

  const subscription = (id: number) => {
    const found = subscriptions.get(id);
    if (!found) throw new IpcError("notFound", `no subscription ${id}`);
    return found;
  };

  const plain: {
    [C in PlainCommand]: (request: RequestOf<C>) => ResponseOf<C>;
  } = {
    spaces_list: () => [...spaces],
    space_open: (name) => {
      if (!CONTEXTS.some((context) => context.name === name)) {
        throw new IpcError("notFound", `no source lists the context ${name}`);
      }
      const open = spaces.find(
        (candidate) =>
          candidate.contexts.length === 1 && candidate.contexts[0] === name,
      );
      if (open) return open;
      const created = { id: name, name, contexts: [name] };
      spaces.push(created);
      return created;
    },
    resources_list: (id) => {
      space(id);
      return RESOURCES;
    },
    cluster_version: (name) => {
      const version = VERSIONS[name];
      if (!version) throw new IpcError("notFound", `no context ${name}`);
      auth.check(name);
      return { gitVersion: version };
    },
    context_sign_in: (context) => auth.signIn(context),
    context_sign_in_cancel: (context) => auth.cancel(context),
    exec_review: () => auth.review(),
    exec_trust: (digests) => auth.trust(digests),
    url_open: (url) => {
      if (!signInLink(url)) {
        throw new IpcError(
          "invalidInput",
          `Twigo opens only sign-in links: ${url}`,
        );
      }
      globalThis.open(url, "_blank", "noopener,noreferrer");
      return null;
    },
    namespaces_list: (id) => {
      space(id);
      if (lists === "forbidden") {
        throw new IpcError("forbidden", "you may not list namespaces");
      }
      return [...NAMESPACES].sort();
    },
    shell_environment_retry: () => {
      if (environment.state !== "failed") return null;
      setEnvironment({ state: "resolving" });
      setTimeout(() => {
        setEnvironment(resolved);
      }, RETRY_MS);
      return null;
    },
    state_load: () => ({
      app: Object.fromEntries(appState),
      spaces: Object.fromEntries(
        [...spaceState].map(([id, values]) => [id, Object.fromEntries(values)]),
      ),
    }),
    state_set: (entries) => {
      for (const { space: id, key, value } of entries) {
        if (id !== null) space(id);
        try {
          JSON.parse(value);
        } catch {
          throw new IpcError("invalidInput", `the value of ${key} is not JSON`);
        }
      }
      for (const { space: id, key, value } of entries) {
        if (id === null) {
          appState.set(key, value);
          continue;
        }
        let values = spaceState.get(id);
        if (!values) {
          values = new Map();
          spaceState.set(id, values);
        }
        values.set(key, value);
      }
      return null;
    },
    list_set_window: ({ id, start, end }) => {
      subscription(id).setWindow(start, end);
      return null;
    },
    list_ack: ({ id, seq }) => {
      subscription(id).ack(seq);
      return null;
    },
    list_unsubscribe: (id) => {
      subscription(id).close();
      subscriptions.delete(id);
      if (subscriptions.size === 0) {
        clearInterval(churn);
        churn = undefined;
      }
      return null;
    },
  };

  const demoChurn = () =>
    setInterval(() => {
      for (const [context, target] of clusters) {
        const focus = [...subscriptions.values()].flatMap((sub) =>
          sub.windowIds(context),
        );
        target.churn(Math.ceil(target.pods.length / 500), focus, Date.now());
      }
      for (const sub of subscriptions.values()) sub.touch();
    }, CHURN_MS);

  const steadyChurn = (rate: number) => {
    const started = Date.now();
    let applied = 0;
    return setInterval(() => {
      const due = Math.floor(((Date.now() - started) * rate) / 1000) - applied;
      if (due <= 0) return;
      applied += due;
      for (const target of clusters.values()) target.change(due);
      for (const sub of subscriptions.values()) sub.touch();
    }, RATE_TICK_MS);
  };

  const streams: {
    [C in SubscriptionCommand]: (
      request: RequestOf<C>,
      onMessage: (message: MessageOf<C>) => void,
    ) => ResponseOf<C>;
  } = {
    list_subscribe: (query, onMessage) => {
      const [context] = space(query.space).contexts;
      if (context === undefined) {
        throw new IpcError("notFound", `space ${query.space} has no context`);
      }
      const columns = podColumns(query);
      checkQuery(query, columns);
      const id = nextId++;
      subscriptions.set(
        id,
        new Subscription(query, columns, cluster(context), lists, onMessage),
      );
      if (lists === "live" && churn === undefined) {
        churn =
          changesPerSecond === undefined
            ? demoChurn()
            : steadyChurn(changesPerSecond);
      }
      return id;
    },
    contexts_watch: () => CONTEXTS,
    context_auth_watch: (context, onMessage) => auth.watch(context, onMessage),
    keyboard_layout_watch: () => LAYOUTS[layout],
    shell_environment_watch: (_request, onMessage) => {
      environmentWatchers.add(onMessage);
      return environment;
    },
  };

  return {
    invoke<C extends PlainCommand>(command: C, request: RequestOf<C>) {
      return settle(() => plain[command](request));
    },
    subscribe<C extends SubscriptionCommand>(
      command: C,
      request: RequestOf<C>,
      onMessage: (message: MessageOf<C>) => void,
    ) {
      return settle(() => streams[command](request, onMessage));
    },
  };
}

/** Rust's `sign_in_url` rule: https, or http to localhost or 127.0.0.1, without a user part; WHATWG's URL parser may read an unusual link otherwise than Rust's. */
function signInLink(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "") return false;
  return (
    parsed.protocol === "https:" ||
    (parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"))
  );
}

/** Answers asynchronously, as IPC does. */
function settle<T>(run: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(run());
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }, 0);
  });
}

const PINNED: Readonly<Record<Exclude<ListScenario, "live">, ViewState>> = {
  queued: { state: "queued" },
  connecting: { state: "connecting" },
  syncing: { state: "syncing", loaded: 1850 },
  ready: { state: "ready" },
  relisting: { state: "relisting" },
  stale: { state: "stale" },
  forbidden: { state: "forbidden", verb: "list", resource: "pods" },
  unauthorized: { state: "unauthorized" },
  error: {
    state: "error",
    error: {
      kind: "unavailable",
      message: "dial tcp 10.0.0.1:6443: connect: connection refused",
    },
  },
};

/** States in which a view shows rows. */
const SHOWS_ROWS = new Set<ViewState["state"]>(["ready", "relisting", "stale"]);

/** The batcher of one subscription: one unacknowledged batch at a time, the latest state wins. */
class Subscription {
  readonly #query: ListQuery;
  readonly #cluster: Cluster;
  readonly #columns: Column[];
  readonly #onMessage: (batch: ListBatch) => void;
  readonly #timers: ReturnType<typeof setTimeout>[] = [];
  #status: ViewState;
  #window: [number, number] = [0, 0];
  #seq = 0;
  #acked = 0;
  #dirty = true;
  #cache: { version: number; rows: Pod[]; counted: Pod[] } | undefined;
  #sent: {
    total: number;
    ids: readonly RowId[];
    versions: ReadonlyMap<RowId, number>;
    status: string;
    groups: string;
  } = { total: -1, ids: [], versions: new Map(), status: "", groups: "" };

  constructor(
    query: ListQuery,
    columns: Column[],
    cluster: Cluster,
    scenario: ListScenario,
    onMessage: (batch: ListBatch) => void,
  ) {
    this.#query = query;
    this.#cluster = cluster;
    this.#columns = columns;
    this.#onMessage = onMessage;
    if (scenario === "live" && cluster.synced) {
      this.#status = { state: "ready" };
    } else if (scenario === "live") {
      this.#status = { state: "connecting" };
      const total = cluster.pods.length;
      [0.25, 0.6, 0.9].forEach((share, step) => {
        this.#later(300 + step * 250, {
          state: "syncing",
          loaded: Math.round(total * share),
        });
      });
      this.#later(1100, { state: "ready" }, () => {
        cluster.synced = true;
      });
    } else {
      this.#status = PINNED[scenario];
    }
    this.#timers.push(
      setInterval(() => {
        this.#flush();
      }, FLUSH_MS),
    );
  }

  /** Flushes at once rather than on the next tick, as Rust's batcher does (ARCHITECTURE 3.5). */
  setWindow(start: number, end: number): void {
    this.#window = [start, end];
    this.touch();
    this.#timers.push(
      setTimeout(() => {
        this.#flush();
      }, 0),
    );
  }

  ack(seq: number): void {
    if (seq === this.#seq) this.#acked = seq;
  }

  touch(): void {
    this.#dirty = true;
  }

  close(): void {
    for (const timer of this.#timers) clearTimeout(timer);
  }

  /** The ids of this subscription's window that live in `context`. */
  windowIds(context: string): RowId[] {
    return this.#sent.ids.filter((id) => id.startsWith(`${context}/`));
  }

  #later(ms: number, status: ViewState, then?: () => void): void {
    this.#timers.push(
      setTimeout(() => {
        this.#status = status;
        this.touch();
        then?.();
      }, ms),
    );
  }

  #pods(): { rows: Pod[]; counted: Pod[] } {
    if (!SHOWS_ROWS.has(this.#status.state)) return { rows: [], counted: [] };
    const { version, pods } = this.#cluster;
    if (this.#cache?.version !== version) {
      this.#cache = { version, ...runQuery(pods, this.#query, this.#columns) };
    }
    return this.#cache;
  }

  #flush(): void {
    if (!this.#dirty || this.#seq !== this.#acked) return;
    this.#dirty = false;
    const { rows: pods, counted } = this.#pods();
    const [start, end] = this.#window;
    const visible = pods.slice(start, end);
    const ids = visible.map((pod) => pod.id);
    const status = JSON.stringify(this.#status);
    const groups = this.#groups(counted);
    const groupsJson = JSON.stringify(groups);
    const groupsChanged = groupsJson !== this.#sent.groups;
    const first = this.#seq === 0;
    const windowChanged =
      first ||
      ids.length !== this.#sent.ids.length ||
      ids.some((id, i) => id !== this.#sent.ids[i]);
    const upserts = visible.filter(
      (pod) => this.#sent.versions.get(pod.id) !== pod.version,
    );
    if (
      !windowChanged &&
      upserts.length === 0 &&
      status === this.#sent.status &&
      !groupsChanged &&
      pods.length === this.#sent.total
    ) {
      return;
    }
    const withNamespace = this.#columns.some((c) => c.name === "Namespace");
    this.#sent = {
      total: pods.length,
      ids,
      versions: new Map(visible.map((pod) => [pod.id, pod.version])),
      status,
      groups: groupsJson,
    };
    this.#seq++;
    this.#onMessage({
      seq: this.#seq,
      total: pods.length,
      columns: first ? this.#columns : null,
      window: windowChanged ? { start, ids } : null,
      upserts: upserts.map((pod) => podRow(pod, withNamespace)),
      status: this.#status,
      groups: groups && (first || groupsChanged) ? groups : null,
    });
  }

  /** The matching pods per value of the `groupBy` column, largest first. */
  #groups(pods: readonly Pod[]): GroupCount[] | null {
    const column = this.#query.groupBy;
    if (column === null) return null;
    const at = this.#columns.findIndex(
      (candidate) => candidate.name === column,
    );
    const withNamespace = this.#columns.some((c) => c.name === "Namespace");
    const counts = new Map<string, number>();
    for (const pod of pods) {
      const value = String(podCells(pod, withNamespace)[at] ?? "");
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }
}
