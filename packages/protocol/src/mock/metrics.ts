import type {
  Cell,
  Column,
  ContainerUsage,
  Measure,
  MetricsState,
  RowId,
  Usage,
} from "../generated";
import { hash, type Node, type Pod } from "./cluster";
import type { MockRow } from "./kinds";
import { CONTAINER_NAMES } from "./shell";

/**
 * What the context says of the Metrics API: `metricsNone` serves none, so
 * its lists have no metric columns and its objects no usage, `metricsDown`
 * serves it without an answer, `metricsForbidden` to nobody the person is,
 * and `metricsRemoved` stops serving it once the backend has run for
 * `REMOVED_MS`.
 */
export type MetricsScenario =
  "metricsNone" | "metricsDown" | "metricsForbidden" | "metricsRemoved";

export const METRICS_SCENARIOS: readonly MetricsScenario[] = [
  "metricsNone",
  "metricsDown",
  "metricsForbidden",
  "metricsRemoved",
];

export const REMOVED_MS = 20_000;

export const METRICS_GROUP = "metrics.k8s.io";

export function isMetricsScenario(
  scenario: string,
): scenario is MetricsScenario {
  return (METRICS_SCENARIOS as readonly string[]).includes(scenario);
}

/** metrics-server's resolution in its stock manifest: every sample moves at a scrape. */
export const SCRAPE_MS = 15_000;
/** A pod needs two scrapes before it has a sample, so a younger one has none. */
const YOUNG_MS = 30_000;
/** A scrape changes the samples of a third of the pods. */
const SHARES = 3;
/** What a scope nobody read before takes to answer: one flush of a list. */
export const ANSWER_MS = 50;

const MI = 1024 * 1024;
const MILLI = 1_000_000;
/** The node the Overview of the recorded node says: 16 CPUs and 16355060Ki. */
const ALLOCATABLE = { cpu: 16_000 * MILLI, memory: 16_355_060 * 1024 };

export interface Sample {
  readonly cpu: number;
  readonly memory: number;
}

export interface Resources {
  readonly cpu: number | null;
  readonly memory: number | null;
}

export interface ContainerSpec {
  readonly name: string;
  readonly request: Resources;
  readonly limit: Resources;
}

function unit(text: string): number {
  return hash(text) / 4_294_967_296;
}

function choose<T>(items: readonly T[], text: string): T {
  const item = items[Math.floor(unit(text) * items.length)];
  if (item === undefined) throw new Error("choose needs a non-empty list");
  return item;
}

/**
 * The containers of a pod with what each asks for, which the pod's
 * Overview shows on the cards and its usage is measured against: one in
 * three has no CPU limit and one in five no memory limit, and one in
 * twenty-five asks for two cores and 2 Gi.
 */
export function containerSpecs(pod: Pod): ContainerSpec[] {
  return CONTAINER_NAMES.slice(0, pod.containers).map((name) => {
    const seed = `${pod.id}/${name}`;
    const big = unit(`${seed}/big`) < 0.04;
    const cpu =
      (big ? 2000 : choose([25, 50, 100, 250, 500], `${seed}/cpu`)) * MILLI;
    const memory =
      (big ? 2048 : choose([32, 64, 128, 256, 512], `${seed}/memory`)) * MI;
    return {
      name,
      request: { cpu, memory },
      limit: {
        cpu: unit(`${seed}/cpu limit`) < 1 / 3 ? null : cpu * 4,
        memory: unit(`${seed}/memory limit`) < 1 / 5 ? null : memory * 2,
      },
    };
  });
}

function measure(
  used: number | null,
  request: number | null,
  limit: number | null,
  allocatable: number | null = null,
): Measure {
  return { used, request, limit, allocatable };
}

const NOTHING: Measure = measure(null, null, null);

export const ABSENT: Usage = {
  state: "absent",
  waiting: false,
  sampled: null,
  cpu: NOTHING,
  memory: NOTHING,
  containers: [],
};

/** The sum of values that all exist, else none, as a pod's request and limit are. */
function allOrNone(values: readonly (number | null)[]): number | null {
  if (values.length === 0 || values.some((value) => value === null)) {
    return null;
  }
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

/**
 * What the Metrics API answers for the mock's pods and nodes (ARCHITECTURE
 * 3.6): a sample moves at a scrape, for a third of the pods each, and a
 * pod has none while it is pending, finished, failed or younger than two
 * scrapes. One node is over 90 % of its memory and one over its CPUs.
 */
export class MockMetrics {
  readonly board = new MetricsBoard(() => this.state);
  readonly #scenario: MetricsScenario | undefined;
  readonly #clock: () => number;
  readonly #watchers = new Set<() => void>();
  #served: boolean;

  constructor(
    scenario: MetricsScenario | undefined,
    clock: () => number = () => Date.now(),
  ) {
    this.#scenario = scenario;
    this.#clock = clock;
    this.#served = scenario !== "metricsNone";
    if (scenario === "metricsRemoved") {
      setTimeout(() => {
        this.#served = false;
        for (const watcher of this.#watchers) watcher();
      }, REMOVED_MS);
    }
  }

  get served(): boolean {
    return this.#served;
  }

  get stale(): boolean {
    return this.#scenario === "metricsDown";
  }

  get state(): MetricsState | null {
    if (!this.#served) return null;
    switch (this.#scenario) {
      case "metricsDown":
        return "unavailable";
      case "metricsForbidden":
        return "forbidden";
      default:
        return "ready";
    }
  }

  /** Tells `watcher` when the context stops serving the API; returns what stops it. */
  watch(watcher: () => void): () => void {
    this.#watchers.add(watcher);
    return () => this.#watchers.delete(watcher);
  }

  get scrape(): number {
    return Math.floor(this.#clock() / SCRAPE_MS);
  }

  get untilScrape(): number {
    return SCRAPE_MS - (this.#clock() % SCRAPE_MS);
  }

  sample(subject: NonNullable<MockRow["metric"]>): Sample | null {
    if (this.state !== "ready") return null;
    if (subject.kind === "node") return this.nodeSample(subject.node);
    const containers = this.containers(subject.pod);
    if (containers === null) return null;
    return {
      cpu: containers.reduce((sum, { cpu }) => sum + (cpu.used ?? 0), 0),
      memory: containers.reduce(
        (sum, { memory }) => sum + (memory.used ?? 0),
        0,
      ),
    };
  }

  /**
   * What a scope has said that an open pod or node is told: its state once
   * it has answered, the state a request of it last failed in while it has
   * none open, and a stale API's at once, since discovery knows it without a
   * request. Null before any of these.
   */
  said(scope: string): MetricsState | null {
    if (this.stale || this.board.answered(scope)) return this.state;
    return this.board.refusal(scope) ?? null;
  }

  /**
   * What an open pod is told of what its scope `said`: the running
   * containers with no figure while it has said nothing, as Rust says them
   * with the Overview, else its figures or the state alone.
   */
  podUsage(pod: Pod, said: MetricsState | null): Usage {
    if (said === null) {
      return {
        state: "ready",
        waiting: true,
        sampled: null,
        cpu: NOTHING,
        memory: NOTHING,
        containers: this.running(pod).map(({ name, request, limit }) => ({
          name,
          cpu: measure(null, request.cpu, limit.cpu),
          memory: measure(null, request.memory, limit.memory),
        })),
      };
    }
    const containers = said === "ready" ? this.containers(pod) : null;
    if (containers === null) {
      return {
        state: said,
        waiting: false,
        sampled: null,
        cpu: NOTHING,
        memory: NOTHING,
        containers: [],
      };
    }
    const total = (pick: (container: ContainerUsage) => Measure): Measure => {
      const parts = containers.map(pick);
      return measure(
        parts.reduce((sum, part) => sum + (part.used ?? 0), 0),
        allOrNone(parts.map((part) => part.request)),
        allOrNone(parts.map((part) => part.limit)),
      );
    };
    return {
      state: said,
      waiting: false,
      sampled: new Date(this.scrape * SCRAPE_MS).toISOString(),
      cpu: total((container) => container.cpu),
      memory: total((container) => container.memory),
      containers,
    };
  }

  nodeUsage(node: Node, said: MetricsState | null): Usage {
    const waiting = said === null;
    const ready = said === "ready";
    const sample = this.nodeSample(node);
    return {
      state: said ?? "ready",
      waiting,
      sampled: ready ? new Date(this.scrape * SCRAPE_MS).toISOString() : null,
      cpu: measure(ready ? sample.cpu : null, null, null, ALLOCATABLE.cpu),
      memory: measure(
        ready ? sample.memory : null,
        null,
        null,
        ALLOCATABLE.memory,
      ),
      containers: [],
    };
  }

  nodeSample(node: Node): Sample {
    const wobble = unit(`${node.id}/${this.scrape}`);
    const index = Number(node.name.slice(node.name.lastIndexOf("-") + 1));
    return {
      cpu: Math.round(
        ALLOCATABLE.cpu *
          (index === 2 ? 1.02 + 0.04 * wobble : 0.1 + 0.6 * wobble),
      ),
      memory: Math.round(
        ALLOCATABLE.memory *
          (index === 1 ? 0.92 + 0.04 * wobble : 0.3 + 0.5 * wobble),
      ),
    };
  }

  /**
   * The containers of a pod that run by its own status, in the order a
   * usage lists them: one that ended or waits is not listed, nor a finished
   * init container.
   */
  running(pod: Pod): ContainerSpec[] {
    const specs = containerSpecs(pod);
    return pod.status === "Running"
      ? specs
      : pod.status === "CrashLoopBackOff"
        ? specs.slice(0, pod.ready)
        : [];
  }

  containers(pod: Pod): ContainerUsage[] | null {
    const at = this.scrape * SCRAPE_MS;
    if (at - pod.created < YOUNG_MS) return null;
    const running = this.running(pod);
    if (running.length === 0) return null;
    const version = Math.floor(
      (this.scrape + (hash(pod.id) % SHARES)) / SHARES,
    );
    return running.map(({ name, request, limit }) => {
      const seed = `${pod.id}/${name}`;
      const wobble = unit(`${seed}/${version}`);
      const shape = unit(`${seed}/shape`);
      const cpu = Math.min(
        Math.round((request.cpu ?? 0) * (0.1 + 1.3 * wobble)),
        limit.cpu ?? Infinity,
      );
      const memory = Math.round(
        limit.memory !== null && shape < 0.06
          ? limit.memory * (0.91 + 0.04 * wobble)
          : limit.memory !== null && shape < 0.08
            ? limit.memory * (1 + 0.02 * wobble)
            : Math.min(
                (request.memory ?? 0) * (0.4 + 0.9 * wobble),
                (limit.memory ?? Infinity) * 0.85,
              ),
      );
      return {
        name,
        cpu: measure(cpu, request.cpu, limit.cpu),
        memory: measure(memory, request.memory, limit.memory),
      };
    });
  }
}

export const METRIC_COLUMNS: readonly Column[] = [
  { name: "CPU", kind: "cpu", priority: 0 },
  { name: "Memory", kind: "memory", priority: 0 },
];

/** Where the metric columns go: before the Age column, or last without one. */
export function metricsAt(columns: readonly Column[]): number {
  const age = columns.findIndex((column) => column.kind === "age");
  return age < 0 ? columns.length : age;
}

/** What reads a scope of the board and hears when the scope has answered. */
export interface MetricsReader {
  answer(): void;
}

export function nodesScope(context: string): string {
  return `${context}/nodes`;
}

export function podsScope(context: string, namespace: string): string {
  return `${context}/pods/${namespace}`;
}

/**
 * The scopes that open lists and objects read, a namespace of a context's
 * pods or its nodes, as Rust's board holds them: a scope nobody read answers
 * one flush after a reader first wants it, a scope that gains a reader has
 * answered already, and one that loses its last reader forgets its answer.
 * What a scope's request last ended in, when it failed, stays after its
 * readers leave, until a request of that scope answers.
 */
export class MetricsBoard {
  readonly #scopes = new Map<
    string,
    {
      readonly readers: Set<MetricsReader>;
      answered: boolean;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();
  readonly #refused = new Map<string, MetricsState>();

  /** `outcome` is what a request of any scope ends in, null where the context serves none. */
  constructor(private readonly outcome: () => MetricsState | null) {}

  answered(scope: string): boolean {
    return this.#scopes.get(scope)?.answered === true;
  }

  refusal(scope: string): MetricsState | undefined {
    return this.#refused.get(scope);
  }

  /** What `reader` wants from now on, in place of what it wanted. */
  want(reader: MetricsReader, wanted: ReadonlySet<string>): void {
    for (const [scope, entry] of this.#scopes) {
      if (wanted.has(scope) || !entry.readers.delete(reader)) continue;
      if (entry.readers.size === 0) {
        clearTimeout(entry.timer);
        this.#scopes.delete(scope);
      }
    }
    for (const scope of wanted) {
      const held = this.#scopes.get(scope);
      if (held) {
        held.readers.add(reader);
        continue;
      }
      const readers = new Set([reader]);
      const entry = {
        readers,
        answered: false,
        timer: setTimeout(() => {
          entry.answered = true;
          this.#remember(scope);
          for (const each of readers) each.answer();
        }, ANSWER_MS),
      };
      this.#scopes.set(scope, entry);
    }
  }

  #remember(scope: string): void {
    const outcome = this.outcome();
    if (outcome === null || outcome === "ready") {
      this.#refused.delete(scope);
    } else {
      this.#refused.set(scope, outcome);
    }
  }
}

/**
 * What a list of pods or nodes reads of the Metrics API, as Rust's query
 * view joins it: the samples of the rows its window showed while it read,
 * or of every row while it sorts by a metric, from the scopes that have
 * answered. A list that stops reading keeps what it has, and a row without
 * a sample has null cells. It reports the state of the API only from a scope
 * that has answered, or has refused before and not answered since, and keeps
 * what it said when it stops reading, so a fresh list says none until its
 * first answer, but for a stale API, which discovery tells at once as
 * `unavailable`.
 */
export class MetricsJoin {
  readonly #metrics: MockMetrics;
  readonly #samples = new Map<RowId, Sample>();
  readonly #namespaces: ReadonlySet<string>;
  #reads = false;
  #wanted: ReadonlySet<string> = new Set();
  #reported: MetricsState | null;
  #listener: (() => void) | undefined;
  readonly #stop: () => void;
  #polled: { rows: readonly MockRow[]; scrape: number } | undefined;
  /** Bumped when a sample a sort reads changed. */
  version = 0;

  constructor(
    metrics: MockMetrics,
    readonly at: number,
    private readonly context: string,
    namespaces: readonly string[],
  ) {
    this.#metrics = metrics;
    this.#namespaces = new Set(namespaces);
    this.#reported = metrics.stale ? "unavailable" : null;
    this.#stop = metrics.watch(() => {
      this.#listener?.();
    });
  }

  get state(): MetricsState | null {
    return this.#reported;
  }

  get served(): boolean {
    return this.#metrics.served;
  }

  get scrape(): number {
    return this.#metrics.scrape;
  }

  get waiting(): boolean {
    return [...this.#wanted].some(
      (scope) => !this.#metrics.board.answered(scope),
    );
  }

  reads(on: boolean): void {
    if (on === this.#reads) return;
    this.#reads = on;
    this.#polled = undefined;
    if (!on) this.#want(new Set());
  }

  listen(listener: () => void): void {
    this.#listener = listener;
  }

  answer(): void {
    this.#polled = undefined;
    this.#listener?.();
  }

  close(): void {
    this.#stop();
    this.#want(new Set());
  }

  pad(cells: readonly Cell[]): Cell[] {
    return [...cells.slice(0, this.at), null, null, ...cells.slice(this.at)];
  }

  /**
   * The refusal the board remembers of the scopes of `rows`, for a list that
   * knows its columns before it shows rows, and so reads nothing yet.
   */
  recall(rows: readonly MockRow[]): void {
    const { board, state } = this.#metrics;
    if (!this.#reads || state === null) return;
    for (const row of rows) {
      const scope = this.#scope(row);
      if (scope !== undefined) this.#reported ??= board.refusal(scope) ?? null;
    }
  }

  /**
   * Polls the scopes of `rows` if the list reads; with `sorting`, a sort
   * reads every row, and one that changed a sample is told by `version`.
   */
  poll(rows: readonly MockRow[], sorting: boolean): void {
    if (!this.#reads) return;
    const scrape = this.scrape;
    if (
      sorting &&
      this.#polled?.rows === rows &&
      this.#polled.scrape === scrape
    ) {
      return;
    }
    const scopes = new Map<RowId, string>();
    for (const row of rows) {
      const scope = this.#scope(row);
      if (scope !== undefined) scopes.set(row.id, scope);
    }
    this.#want(new Set(scopes.values()));
    const { board, state } = this.#metrics;
    if (state === null) return;
    const answered = (id: RowId) => {
      const scope = scopes.get(id);
      return scope !== undefined && board.answered(scope);
    };
    if ([...this.#wanted].some((scope) => board.answered(scope))) {
      this.#reported = state;
    } else {
      for (const scope of this.#wanted) {
        this.#reported ??= board.refusal(scope) ?? null;
      }
    }
    if (state !== "ready") return;
    let changed = false;
    for (const row of rows) {
      if (row.metric === undefined || !answered(row.id)) continue;
      const before = this.#samples.get(row.id);
      const sample = this.#metrics.sample(row.metric);
      if (sample === null) {
        changed ||= this.#samples.delete(row.id);
      } else if (
        before?.cpu !== sample.cpu ||
        before.memory !== sample.memory
      ) {
        this.#samples.set(row.id, sample);
        changed = true;
      }
    }
    if (sorting) {
      this.#polled = { rows, scrape };
      if (changed) this.version++;
    }
  }

  fill(row: MockRow): MockRow {
    const sample = this.#samples.get(row.id);
    if (!sample) return row;
    const cells = [...row.cells];
    cells[this.at] = sample.cpu;
    cells[this.at + 1] = sample.memory;
    return { ...row, cells };
  }

  #scope({ metric }: MockRow): string | undefined {
    if (metric === undefined) return undefined;
    if (metric.kind === "node") return nodesScope(this.context);
    const { namespace } = metric.pod;
    if (this.#namespaces.size > 0 && !this.#namespaces.has(namespace)) {
      return undefined;
    }
    return podsScope(this.context, namespace);
  }

  #want(scopes: ReadonlySet<string>): void {
    this.#wanted = scopes;
    this.#metrics.board.want(this, scopes);
  }
}
