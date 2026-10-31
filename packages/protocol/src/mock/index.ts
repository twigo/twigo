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
  ListBatch,
  ListQuery,
  RowId,
  ViewState,
} from "../generated";
import { Cluster, podRow, type Pod } from "./cluster";
import { POD_COUNT, SPACES } from "./fixtures";
import { checkQuery, podColumns, runQuery } from "./query";

/** `live` connects, syncs and then changes pods every second; any other value pins that state. */
export type MockScenario = "live" | ViewState["state"];

export const MOCK_SCENARIOS: readonly MockScenario[] = [
  "live",
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

const FLUSH_MS = 50;
const CHURN_MS = 1000;

/**
 * Runs the UI in a plain browser on fixtures (ARCHITECTURE 2.3): spaces, and
 * pods behind a query view with the same windowing and flow control as Rust.
 */
export function createMockBackend(scenario: MockScenario = "live"): Backend {
  const now = Date.now();
  const clusters = new Map<string, Cluster>();
  const subscriptions = new Map<number, Subscription>();
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

  const subscription = (id: number) => {
    const found = subscriptions.get(id);
    if (!found) throw new IpcError("notFound", `no subscription ${id}`);
    return found;
  };

  const plain: {
    [C in PlainCommand]: (request: RequestOf<C>) => ResponseOf<C>;
  } = {
    spaces_list: () => SPACES,
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

  const streams: {
    [C in SubscriptionCommand]: (
      request: RequestOf<C>,
      onMessage: (message: MessageOf<C>) => void,
    ) => ResponseOf<C>;
  } = {
    list_subscribe: (query, onMessage) => {
      const space = SPACES.find((candidate) => candidate.id === query.space);
      if (!space) throw new IpcError("notFound", `no space ${query.space}`);
      const columns = podColumns(space.contexts.length, query);
      checkQuery(query, columns);
      const id = nextId++;
      subscriptions.set(
        id,
        new Subscription(
          query,
          columns,
          space.contexts.map((context) => cluster(context.name)),
          scenario,
          onMessage,
        ),
      );
      if (scenario === "live" && churn === undefined) {
        churn = setInterval(() => {
          for (const [context, target] of clusters) {
            const focus = [...subscriptions.values()].flatMap((sub) =>
              sub.windowIds(context),
            );
            target.churn(
              Math.ceil(target.pods.length / 500),
              focus,
              Date.now(),
            );
          }
          for (const sub of subscriptions.values()) sub.touch();
        }, CHURN_MS);
      }
      return id;
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

const PINNED: Readonly<Record<Exclude<MockScenario, "live">, ViewState>> = {
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
  readonly #clusters: readonly Cluster[];
  readonly #columns: Column[];
  readonly #onMessage: (batch: ListBatch) => void;
  readonly #timers: ReturnType<typeof setTimeout>[] = [];
  #status: ViewState;
  #window: [number, number] = [0, 0];
  #seq = 0;
  #acked = 0;
  #dirty = true;
  #cache: { version: string; pods: Pod[] } | undefined;
  #sent: {
    total: number;
    ids: readonly RowId[];
    versions: ReadonlyMap<RowId, number>;
    status: string;
  } = { total: -1, ids: [], versions: new Map(), status: "" };

  constructor(
    query: ListQuery,
    columns: Column[],
    clusters: readonly Cluster[],
    scenario: MockScenario,
    onMessage: (batch: ListBatch) => void,
  ) {
    this.#query = query;
    this.#clusters = clusters;
    this.#columns = columns;
    this.#onMessage = onMessage;
    if (scenario === "live" && clusters.every((c) => c.synced)) {
      this.#status = { state: "ready" };
    } else if (scenario === "live") {
      this.#status = { state: "connecting" };
      const total = clusters.reduce((sum, c) => sum + c.pods.length, 0);
      [0.25, 0.6, 0.9].forEach((share, step) => {
        this.#later(300 + step * 250, {
          state: "syncing",
          loaded: Math.round(total * share),
        });
      });
      this.#later(1100, { state: "ready" }, () => {
        for (const cluster of clusters) cluster.synced = true;
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

  setWindow(start: number, end: number): void {
    this.#window = [start, end];
    this.touch();
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

  #pods(): Pod[] {
    if (!SHOWS_ROWS.has(this.#status.state)) return [];
    const version = this.#clusters.map((c) => c.version).join(",");
    if (this.#cache?.version !== version) {
      const pods = this.#clusters.flatMap((c) => c.pods);
      this.#cache = {
        version,
        pods: runQuery(pods, this.#query, this.#columns),
      };
    }
    return this.#cache.pods;
  }

  #flush(): void {
    if (!this.#dirty || this.#seq !== this.#acked) return;
    this.#dirty = false;
    const pods = this.#pods();
    const [start, end] = this.#window;
    const visible = pods.slice(start, end);
    const ids = visible.map((pod) => pod.id);
    const status = JSON.stringify(this.#status);
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
      pods.length === this.#sent.total
    ) {
      return;
    }
    const withContext = this.#columns[0]?.name === "Context";
    const withNamespace = this.#columns.some((c) => c.name === "Namespace");
    this.#sent = {
      total: pods.length,
      ids,
      versions: new Map(visible.map((pod) => [pod.id, pod.version])),
      status,
    };
    this.#seq++;
    this.#onMessage({
      seq: this.#seq,
      total: pods.length,
      columns: first ? this.#columns : null,
      window: windowChanged ? { start, ids } : null,
      upserts: upserts.map((pod) => podRow(pod, withContext, withNamespace)),
      status: this.#status,
    });
  }
}
