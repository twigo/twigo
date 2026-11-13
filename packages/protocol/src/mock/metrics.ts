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
 * serves it without an answer, `metricsForbidden` to nobody the person is.
 */
export type MetricsScenario =
  "metricsNone" | "metricsDown" | "metricsForbidden";

export const METRICS_SCENARIOS: readonly MetricsScenario[] = [
  "metricsNone",
  "metricsDown",
  "metricsForbidden",
];

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
 * three has no CPU limit and one in five no memory limit.
 */
export function containerSpecs(pod: Pod): ContainerSpec[] {
  return CONTAINER_NAMES.slice(0, pod.containers).map((name) => {
    const seed = `${pod.id}/${name}`;
    const cpu = choose([25, 50, 100, 250, 500], `${seed}/cpu`) * MILLI;
    const memory = choose([32, 64, 128, 256, 512], `${seed}/memory`) * MI;
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
  readonly #scenario: MetricsScenario | undefined;
  readonly #clock: () => number;

  constructor(
    scenario: MetricsScenario | undefined,
    clock: () => number = () => Date.now(),
  ) {
    this.#scenario = scenario;
    this.#clock = clock;
  }

  get served(): boolean {
    return this.#scenario !== "metricsNone";
  }

  /** What it answers; none for a context that does not serve it. */
  get state(): MetricsState | null {
    switch (this.#scenario) {
      case "metricsNone":
        return null;
      case "metricsDown":
        return "unavailable";
      case "metricsForbidden":
        return "forbidden";
      case undefined:
        return "ready";
    }
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

  podUsage(pod: Pod): Usage {
    const state = this.state;
    if (state === null) throw new Error("the context serves no metrics");
    const containers = state === "ready" ? this.containers(pod) : null;
    if (containers === null) {
      return {
        state,
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
      state,
      sampled: new Date(this.scrape * SCRAPE_MS).toISOString(),
      cpu: total((container) => container.cpu),
      memory: total((container) => container.memory),
      containers,
    };
  }

  nodeUsage(node: Node): Usage {
    const state = this.state;
    if (state === null) throw new Error("the context serves no metrics");
    const sample = this.nodeSample(node);
    const ready = state === "ready";
    return {
      state,
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

  containers(pod: Pod): ContainerUsage[] | null {
    const at = this.scrape * SCRAPE_MS;
    if (at - pod.created < YOUNG_MS) return null;
    const specs = containerSpecs(pod);
    const running =
      pod.status === "Running"
        ? specs
        : pod.status === "CrashLoopBackOff"
          ? specs.slice(0, pod.ready)
          : [];
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

/** The columns of the Metrics API, which a list of pods or nodes gets before its Age. */
export const METRIC_COLUMNS: readonly Column[] = [
  { name: "CPU", kind: "cpu", priority: 0 },
  { name: "Memory", kind: "memory", priority: 0 },
];

/** Where the metric columns go: before the Age column, or last without one. */
export function metricsAt(columns: readonly Column[]): number {
  const age = columns.findIndex((column) => column.kind === "age");
  return age < 0 ? columns.length : age;
}

/**
 * What a list of pods or nodes reads of the Metrics API, as Rust's query
 * view joins it: the samples of the rows its window showed while it read,
 * or of every row while it sorts by a metric. A list that stops reading
 * keeps what it has, and a row without a sample has null cells.
 */
export class MetricsJoin {
  readonly #metrics: MockMetrics;
  readonly #samples = new Map<RowId, Sample>();
  #reads = false;
  #polled: { rows: readonly MockRow[]; scrape: number } | undefined;
  /** Bumped when a sample a sort reads changed. */
  version = 0;

  constructor(
    metrics: MockMetrics,
    readonly at: number,
  ) {
    this.#metrics = metrics;
  }

  get state(): MetricsState | null {
    return this.#metrics.state;
  }

  get scrape(): number {
    return this.#metrics.scrape;
  }

  reads(on: boolean): void {
    this.#reads = on;
  }

  pad(cells: readonly Cell[]): Cell[] {
    return [...cells.slice(0, this.at), null, null, ...cells.slice(this.at)];
  }

  /**
   * Polls the namespaces of `rows` if the list reads; with `sorting`, a
   * sort reads every row, and one that changed a sample is told by `version`.
   */
  poll(rows: readonly MockRow[], sorting: boolean): void {
    if (!this.#reads || this.state !== "ready") return;
    const scrape = this.scrape;
    if (
      sorting &&
      this.#polled?.rows === rows &&
      this.#polled.scrape === scrape
    ) {
      return;
    }
    let changed = false;
    for (const row of rows) {
      if (row.metric === undefined) continue;
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
}
