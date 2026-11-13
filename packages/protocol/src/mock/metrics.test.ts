import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Backend } from "../backend";
import type {
  Cell,
  Column,
  Discovered,
  ListBatch,
  ListQuery,
  ObjectBatch,
  ObjectParts,
  Row,
  Usage,
} from "../generated";
import { Cluster, type Pod } from "./cluster";
import { createMockBackend, type MockScenario } from "./index";
import {
  ANSWER_MS,
  containerSpecs,
  METRIC_COLUMNS,
  MockMetrics,
  REMOVED_MS,
  SCRAPE_MS,
} from "./metrics";
import { compileQuery, natural, runQuery, type QueryRow } from "./query";

function query(rest: Partial<ListQuery> = {}): ListQuery {
  return {
    space: "staging",
    gvr: { group: "", version: "v1", resource: "pods" },
    namespaced: true,
    namespaces: [],
    labelSelector: null,
    fieldSelector: null,
    owners: null,
    text: null,
    columns: null,
    sort: null,
    countBy: null,
    groupBy: null,
    values: null,
    ...rest,
  };
}

const NODES = query({
  gvr: { group: "", version: "v1", resource: "nodes" },
  namespaced: false,
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function call<T>(answer: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(0);
  return answer;
}

async function list(scenario: MockScenario, q: ListQuery = query()) {
  const backend = createMockBackend(scenario);
  const batches: ListBatch[] = [];
  const pending = backend.subscribe("list_subscribe", q, (batch) =>
    batches.push(batch),
  );
  await vi.advanceTimersByTimeAsync(0);
  const id = await pending;
  const rows = new Map<string, Row>();
  let ids: string[] = [];
  let columns: Column[] = [];
  let seen = 0;
  const sync = async () => {
    for (const batch of batches.slice(seen)) {
      if (batch.columns) columns = batch.columns;
      if (batch.window) ids = batch.window.ids;
      for (const row of batch.upserts) rows.set(row.id, row);
    }
    seen = batches.length;
    const latest = batches[batches.length - 1];
    if (latest) {
      await call(backend.invoke("list_ack", { id, seq: latest.seq }));
    }
  };
  const window = async (start: number, end: number, metrics: boolean) => {
    await call(backend.invoke("list_set_window", { id, start, end, metrics }));
    await vi.advanceTimersByTimeAsync(100);
    await sync();
  };
  const at = (name: string) => columns.findIndex((c) => c.name === name);
  const shown = () => ids.flatMap((rowId) => rows.get(rowId) ?? []);
  const column = (name: string): Cell[] =>
    shown().map((row) => row.cells[at(name)] ?? null);
  await vi.advanceTimersByTimeAsync(1200);
  return {
    backend,
    batches,
    columns: () => columns,
    window,
    sync,
    column,
    shown,
    at,
  };
}

const ASLEEP = [
  "Pending",
  "ContainerCreating",
  "ImagePullBackOff",
  "Completed",
  "Error",
];

test("pod and node lists carry CPU and Memory of priority 0 just before Age, from the first batch", async () => {
  const pods = await list("live");
  await pods.window(0, 40, false);
  const first = pods.batches.find((batch) => batch.columns !== null);
  expect(first?.columns?.map((c) => c.name)).toEqual([
    "Name",
    "Namespace",
    "Ready",
    "Status",
    "Restarts",
    "CPU",
    "Memory",
    "Age",
    "IP",
    "Node",
    "Nominated Node",
    "Readiness Gates",
  ]);
  expect(first?.columns?.slice(5, 7)).toEqual([...METRIC_COLUMNS]);
  expect(first?.metrics).toBeNull();
  const nodes = await list("live", NODES);
  await nodes.window(0, 40, false);
  expect(
    nodes.batches
      .find((batch) => batch.columns !== null)
      ?.columns?.slice(2, 6)
      .map((c) => [c.name, c.kind]),
  ).toEqual([
    ["Roles", "string"],
    ["CPU", "cpu"],
    ["Memory", "memory"],
    ["Age", "age"],
  ]);
  const deployments = await list(
    "live",
    query({ gvr: { group: "apps", version: "v1", resource: "deployments" } }),
  );
  await deployments.window(0, 40, true);
  expect(deployments.columns().map((c) => c.kind)).not.toContain("cpu");
  expect(deployments.batches.find((b) => b.metrics !== null)).toBeUndefined();
});

test.each([
  ["pods", query()],
  ["nodes", NODES],
])(
  "a %s list that has not synced yet has an empty list of columns, and CPU and Memory come with the server's, just before Age",
  async (_, q) => {
    const backend = createMockBackend("live");
    const batches: ListBatch[] = [];
    let id = 0;
    const pending = backend.subscribe("list_subscribe", q, (batch) => {
      batches.push(batch);
      void backend.invoke("list_ack", { id, seq: batch.seq });
    });
    await vi.advanceTimersByTimeAsync(0);
    id = await pending;
    await call(
      backend.invoke("list_set_window", {
        id,
        start: 0,
        end: 40,
        metrics: false,
      }),
    );
    await vi.advanceTimersByTimeAsync(2000);
    const states = batches.map((batch) => batch.status.state);
    expect(states[0]).toBe("connecting");
    expect(states).toContain("ready");
    const named = batches.flatMap((batch) =>
      batch.columns ? [batch.columns.map((column) => column.name)] : [],
    );
    expect(named[0]).toEqual([]);
    expect(named.length).toBeGreaterThan(1);
    for (const names of named.slice(1)) {
      const age = names.indexOf("Age");
      expect(names).toContain("Name");
      expect(names.slice(age - 2, age)).toEqual(["CPU", "Memory"]);
    }
  },
);

test("a list of a context that serves no Metrics API has no columns before its kind has synced, as after", async () => {
  const backend = createMockBackend("metricsNone");
  const batches: ListBatch[] = [];
  const pending = backend.subscribe("list_subscribe", query(), (batch) => {
    batches.push(batch);
  });
  await vi.advanceTimersByTimeAsync(0);
  const id = await pending;
  await call(
    backend.invoke("list_set_window", {
      id,
      start: 0,
      end: 40,
      metrics: false,
    }),
  );
  await vi.advanceTimersByTimeAsync(100);
  expect(batches[0]?.status.state).toBe("connecting");
  expect(batches[0]?.columns).toEqual([]);
});

test("values come only while the list says it reads, and stay as they were when it stops", async () => {
  const pods = await list("ready");
  await pods.window(0, 60, false);
  expect(pods.column("CPU").every((cell) => cell === null)).toBe(true);
  expect(pods.column("Memory").every((cell) => cell === null)).toBe(true);

  await pods.window(0, 60, true);
  const cpu = pods.column("CPU");
  expect(cpu.some((cell) => Number.isInteger(cell))).toBe(true);
  expect(cpu.every((cell) => cell === null || Number.isInteger(cell))).toBe(
    true,
  );
  const memory = pods.column("Memory");
  expect(memory.some((cell) => Number.isInteger(cell))).toBe(true);

  await pods.window(0, 60, false);
  const before = pods.batches.length;
  await vi.advanceTimersByTimeAsync(SCRAPE_MS * 3);
  await pods.sync();
  expect(pods.batches.length).toBe(before);
  expect(pods.column("CPU")).toEqual(cpu);
});

test("a scrape moves the values of the rows in view in one batch, and other cells stay", async () => {
  const pods = await list("ready");
  await pods.window(0, 60, true);
  const before = pods.shown().map((row) => [...row.cells]);
  const batches = pods.batches.length;
  await vi.advanceTimersByTimeAsync(SCRAPE_MS);
  await pods.sync();
  expect(pods.batches.length).toBe(batches + 1);
  const cpu = pods.at("CPU");
  const memory = pods.at("Memory");
  const after = pods.shown().map((row) => row.cells);
  const moved = after.filter(
    (cells, index) =>
      cells[cpu] !== before[index]?.[cpu] ||
      cells[memory] !== before[index]?.[memory],
  );
  expect(moved.length).toBeGreaterThan(0);
  for (const [index, cells] of after.entries()) {
    expect(cells.filter((_, at) => at !== cpu && at !== memory)).toEqual(
      before[index]?.filter((_, at) => at !== cpu && at !== memory),
    );
  }
  expect(pods.batches[batches]?.upserts.length).toBe(moved.length);
});

test("a pod has a sample only while it runs and when two scrapes of it passed", () => {
  const metrics = new MockMetrics(undefined);
  const cluster = new Cluster("staging", 400, Date.now());
  const pods = cluster.pods;
  const asleep = pods.filter((pod) => ASLEEP.includes(pod.status));
  expect(asleep.length).toBeGreaterThan(0);
  expect(asleep.map((pod) => metrics.containers(pod))).toEqual(
    asleep.map(() => null),
  );
  const running = pods.filter(
    (pod) => pod.status === "Running" && Date.now() - pod.created > 60_000,
  );
  expect(running.every((pod) => metrics.containers(pod) !== null)).toBe(true);
  const young = { ...running[0], created: Date.now() - 20_000 } as Pod;
  expect(metrics.containers(young)).toBeNull();
  const crashing = {
    ...running[0],
    containers: 3,
    ready: 1,
    status: "CrashLoopBackOff",
  } as Pod;
  expect(metrics.containers(crashing)?.map((c) => c.name)).toEqual(["api"]);
  expect(metrics.containers({ ...crashing, ready: 0 })).toBeNull();
});

test("a third of the pods change at a scrape, all at once, and none between two", () => {
  let now = Math.floor(1_700_000_000_000 / SCRAPE_MS) * SCRAPE_MS;
  const metrics = new MockMetrics(undefined, () => now);
  const pods = new Cluster("staging", 600, now).pods.filter(
    (pod) => pod.status === "Running" && now - pod.created > 60_000,
  );
  const used = () => pods.map((pod) => JSON.stringify(metrics.containers(pod)));
  const first = used();
  now += SCRAPE_MS - 1;
  expect(metrics.untilScrape).toBeGreaterThan(0);
  const same = used();
  now += SCRAPE_MS;
  const second = used();
  const share =
    second.filter((value, index) => value !== first[index]).length /
    pods.length;
  expect(same).toEqual(first);
  expect(share).toBeGreaterThan(0.25);
  expect(share).toBeLessThan(0.42);
});

test("some container has no limit, some pod no sample, and one node is over 90 % of its memory", () => {
  const metrics = new MockMetrics(undefined);
  const cluster = new Cluster("prod-eu", 5000, Date.now());
  const specs = cluster.pods.flatMap((pod) => containerSpecs(pod));
  expect(specs.some((spec) => spec.limit.cpu === null)).toBe(true);
  expect(specs.some((spec) => spec.limit.memory === null)).toBe(true);
  expect(specs.every((spec) => spec.request.cpu !== null)).toBe(true);
  expect(cluster.pods.some((pod) => metrics.containers(pod) === null)).toBe(
    true,
  );
  const usages = cluster.nodes.map((node) => metrics.nodeUsage(node));
  const over = usages.filter(
    ({ memory }) => (memory.used ?? 0) > (memory.allocatable ?? 0) * 0.9,
  );
  expect(over.length).toBeGreaterThan(0);
  expect(over.length).toBeLessThan(usages.length);
});

test("sorting by a metric is numeric, leaves rows without one last in both directions, and ties go by row id", () => {
  const columns: Column[] = [
    { name: "Name", kind: "string", priority: 0 },
    { name: "CPU", kind: "cpu", priority: 0 },
  ];
  const rows: QueryRow[] = (
    [
      ["b", "01", 5],
      ["a", "02", 5],
      ["none-b", "03", null],
      ["c", "04", 20],
      ["none-a", "05", null],
      ["d", "06", 3],
    ] as const
  ).map(([name, id, cpu]) => ({
    id: `x/${id}`,
    namespace: null,
    created: null,
    labels: {},
    controller: null,
    cells: [name, cpu],
  }));
  const sorted = (descending: boolean) =>
    runQuery(
      rows,
      compileQuery(
        query({ sort: { column: "CPU", descending }, namespaced: false }),
        columns,
      ),
    ).rows.map((row) => row.cells[0]);
  expect(sorted(false)).toEqual(["d", "b", "a", "c", "none-b", "none-a"]);
  expect(sorted(true)).toEqual(["c", "b", "a", "d", "none-b", "none-a"]);
});

test("the text filter never matches CPU or Memory", () => {
  const columns: Column[] = [
    { name: "Name", kind: "string", priority: 0 },
    { name: "CPU", kind: "cpu", priority: 0 },
    { name: "Memory", kind: "memory", priority: 0 },
  ];
  const rows: QueryRow[] = [
    {
      id: "x/p",
      namespace: null,
      created: null,
      labels: {},
      controller: null,
      cells: ["p", 123_456, 654_321],
    },
  ];
  const kept = (text: string) =>
    runQuery(rows, compileQuery(query({ text, namespaced: false }), columns))
      .rows.length;
  expect(kept("123")).toBe(0);
  expect(kept("654")).toBe(0);
  expect(kept("p")).toBe(1);
});

test("sorted by CPU, every row has its value whatever the window, in order, with the rows without one last", async () => {
  const pods = await list(
    "ready",
    query({ sort: { column: "CPU", descending: true } }),
  );
  await pods.window(0, 800, true);
  const cpu = pods.column("CPU");
  const numbers = cpu.filter((cell): cell is number => cell !== null);
  expect(numbers.length).toBeGreaterThan(100);
  expect(numbers).toEqual([...numbers].sort((a, b) => b - a));
  expect(cpu.slice(numbers.length).every((cell) => cell === null)).toBe(true);
  await pods.window(300, 340, true);
  expect(pods.column("CPU").slice(0, 3)).toEqual(cpu.slice(300, 303));
});

test("a list that does not read leaves a sort by CPU to Name", async () => {
  const pods = await list(
    "ready",
    query({ sort: { column: "CPU", descending: false } }),
  );
  await pods.window(0, 40, false);
  const names = pods.column("Name").map(String);
  expect(pods.column("CPU").every((cell) => cell === null)).toBe(true);
  expect(names).toEqual([...names].sort(natural));
});

async function reader(backend: Backend, q: ListQuery) {
  const batches: ListBatch[] = [];
  const pending = backend.subscribe("list_subscribe", q, (batch) =>
    batches.push(batch),
  );
  await vi.advanceTimersByTimeAsync(1200);
  const id = await pending;
  const at = () =>
    batches
      .find((batch) => batch.columns !== null)
      ?.columns?.findIndex((column) => column.name === "CPU") ?? -1;
  return {
    batches,
    read: async (metrics = true) => {
      await call(
        backend.invoke("list_set_window", {
          id,
          start: 0,
          end: 60,
          metrics,
        }),
      );
      await vi.advanceTimersByTimeAsync(1);
    },
    next: async (ms = 60) => {
      const latest = batches[batches.length - 1];
      if (latest)
        await call(backend.invoke("list_ack", { id, seq: latest.seq }));
      await vi.advanceTimersByTimeAsync(ms);
    },
    close: () => call(backend.invoke("list_unsubscribe", id)),
    cpu: (batch: ListBatch | undefined) =>
      batch?.upserts.map((row) => row.cells[at()] ?? null) ?? [],
  };
}

const measured = (cells: readonly Cell[]) =>
  cells.some((cell) => Number.isInteger(cell));

test.each([
  ["ready", "ready"],
  ["metricsForbidden", "forbidden"],
] as const)(
  "%s: a list that reads what no other list reads has empty cells and no state in its first batch, and the values or the state one flush later",
  async (scenario, state) => {
    const pods = await reader(createMockBackend(scenario), query());
    await pods.read();
    const [first] = pods.batches;
    expect(first?.columns?.map((column) => column.name)).toContain("CPU");
    expect(first?.metrics).toBeNull();
    expect(first?.upserts.length).toBeGreaterThan(0);
    expect(pods.cpu(first).every((cell) => cell === null)).toBe(true);
    await pods.next();
    const [, second] = pods.batches;
    expect(second?.metrics).toBe(state);
    expect(measured(pods.cpu(second))).toBe(scenario === "ready");
  },
);

test("metricsDown has unavailable in the first batch that has the columns, and nothing changes it or the empty cells", async () => {
  const pods = await reader(createMockBackend("metricsDown"), query());
  await pods.read();
  const [first] = pods.batches;
  expect(first?.columns?.map((column) => column.name)).toContain("CPU");
  expect(first?.metrics).toBe("unavailable");
  expect(first?.upserts.length).toBeGreaterThan(0);
  expect(pods.cpu(first).every((cell) => cell === null)).toBe(true);
  await pods.next();
  await pods.next();
  expect(pods.batches.filter((batch) => batch.metrics !== null)).toHaveLength(
    1,
  );
  expect(
    pods.batches.every((batch) =>
      pods.cpu(batch).every((cell) => cell === null),
    ),
  ).toBe(true);
});

test.each([
  ["ready", "ready"],
  ["metricsForbidden", "forbidden"],
] as const)(
  "%s: a list that stops reading and reads again keeps the state it said, and says no other in between",
  async (scenario, state) => {
    const pods = await reader(createMockBackend(scenario), query());
    await pods.read();
    await pods.next();
    const states = () => pods.batches.flatMap((batch) => batch.metrics ?? []);
    expect(states()).toEqual([state]);
    await pods.read(false);
    await pods.next();
    await pods.next(ANSWER_MS * 3);
    await pods.read();
    await pods.next(ANSWER_MS / 2);
    await pods.next(ANSWER_MS * 3);
    expect(states()).toEqual([state]);
    expect(pods.batches.length).toBeGreaterThan(1);
  },
);

test.each([
  ["ready", "ready"],
  ["metricsForbidden", "forbidden"],
] as const)(
  "%s: a list sorted by a metric waits for its scopes and has the values and the state in its first batch",
  async (scenario, state) => {
    const pods = await reader(
      createMockBackend(scenario),
      query({ sort: { column: "CPU", descending: true } }),
    );
    await pods.read();
    expect(pods.batches).toEqual([]);
    await pods.next();
    const [first] = pods.batches;
    expect(first?.metrics).toBe(state);
    const cpu = pods.cpu(first);
    expect(measured(cpu)).toBe(scenario === "ready");
    const numbers = cpu.filter((cell): cell is number => cell !== null);
    expect(numbers).toEqual([...numbers].sort((a, b) => b - a));
  },
);

test.each([
  ["ready", "ready"],
  ["metricsForbidden", "forbidden"],
] as const)(
  "%s: a list that joins a scope another list reads has the values and the state in its first batch, and the scope forgets its answer with its last reader",
  async (scenario, state) => {
    const backend = createMockBackend(scenario);
    const first = await reader(backend, query());
    await first.read();
    await first.next();
    const second = await reader(backend, query());
    await second.read();
    expect(second.batches[0]?.metrics).toBe(state);
    expect(measured(second.cpu(second.batches[0]))).toBe(scenario === "ready");
    await first.close();
    await second.next();
    await second.close();
    const third = await reader(backend, query());
    await third.read();
    expect(third.batches[0]?.metrics).toBeNull();
    expect(third.cpu(third.batches[0]).every((cell) => cell === null)).toBe(
      true,
    );
  },
);

function usageOf(batches: ObjectBatch[]): Usage | null | undefined {
  return [...batches].reverse().find((batch) => batch.usage !== null)?.usage;
}

async function openOn(
  backend: Backend,
  gvr: { group: string; version: string; resource: string },
  namespace: string | null,
  name: string,
  parts: Partial<ObjectParts> = { usage: true },
  wait = ANSWER_MS + 10,
) {
  const batches: ObjectBatch[] = [];
  const pending = backend.subscribe(
    "object_open",
    {
      object: {
        space: "staging",
        gvr,
        namespaced: namespace !== null,
        namespace,
        name,
      },
      parts: {
        overview: true,
        manifest: false,
        events: false,
        related: false,
        usage: false,
        ...parts,
      },
    },
    (batch) => batches.push(batch),
  );
  await vi.advanceTimersByTimeAsync(0);
  const id = await pending;
  await vi.advanceTimersByTimeAsync(wait);
  return { backend, batches, id };
}

function open(
  scenario: MockScenario,
  gvr: { group: string; version: string; resource: string },
  namespace: string | null,
  name: string,
  parts?: Partial<ObjectParts>,
  wait?: number,
) {
  return openOn(createMockBackend(scenario), gvr, namespace, name, parts, wait);
}

const PODS = { group: "", version: "v1", resource: "pods" };
const NODE_KIND = { group: "", version: "v1", resource: "nodes" };

function sampled(pick: (pod: Pod) => boolean = () => true): Pod {
  const metrics = new MockMetrics(undefined);
  const found = new Cluster("staging", 800, Date.now()).pods.find(
    (pod) => metrics.containers(pod) !== null && pick(pod),
  );
  if (!found) throw new Error("no such pod in the mock");
  return found;
}

test("an open pod answers its usage by container, and the pod's request and limit only where every container has one", async () => {
  const pod = sampled(
    (candidate) => candidate.containers === 3 && candidate.status === "Running",
  );
  const specs = containerSpecs(pod);
  const { batches } = await open("live", PODS, pod.namespace, pod.name);
  const usage = usageOf(batches);
  expect(usage?.state).toBe("ready");
  expect(usage?.sampled).toBe(
    new Date(Math.floor(Date.now() / SCRAPE_MS) * SCRAPE_MS).toISOString(),
  );
  const names = usage?.containers.map((c) => c.name);
  const cards = batches[0]?.overview?.sections
    .flatMap((section) => section.blocks)
    .flatMap((block) => (block.type === "containers" ? block.containers : []))
    .map((container) => container.name);
  expect(names).toEqual(specs.map((spec) => spec.name));
  expect(cards).toEqual(names);
  expect(usage?.cpu.used).toBe(
    usage?.containers.reduce((sum, c) => sum + (c.cpu.used ?? 0), 0),
  );
  const limits = (pick: "cpu" | "memory") =>
    usage?.containers.map((c) => c[pick].limit);
  for (const resource of ["cpu", "memory"] as const) {
    const all = limits(resource)?.every((limit) => limit !== null);
    expect(usage?.[resource].limit !== null).toBe(all);
    expect(usage?.[resource].request).toBe(
      usage?.containers.reduce((sum, c) => sum + (c[resource].request ?? 0), 0),
    );
  }
});

test("an open pod without a sample says so only once its scope has answered, in the state ready", async () => {
  const cluster = new Cluster("staging", 800, Date.now());
  const pending = cluster.pods.find((pod) => pod.status === "Pending");
  if (!pending) throw new Error("no pending pod in the mock");
  const { batches } = await open(
    "live",
    PODS,
    pending.namespace,
    pending.name,
    undefined,
    ANSWER_MS - 1,
  );
  expect(batches.every((batch) => batch.usage === null)).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(usageOf(batches)).toMatchObject({
    state: "ready",
    sampled: null,
    cpu: { used: null },
    memory: { used: null },
    containers: [],
  });
});

test("an open node answers its usage against what it can allocate", async () => {
  const { batches } = await open("live", NODE_KIND, null, "staging-node-1");
  const usage = usageOf(batches);
  expect(usage?.containers).toEqual([]);
  expect(usage?.memory.allocatable).toBe(16_355_060 * 1024);
  expect(usage?.cpu.allocatable).toBe(16_000_000_000);
  expect(
    (usage?.memory.used ?? 0) / (usage?.memory.allocatable ?? 1),
  ).toBeGreaterThan(0.9);
});

test.each([
  ["a pod", "pod"],
  ["a node", "node"],
] as const)(
  "%s: no usage is sent before its scope has answered, and the first one carries the figures",
  async (_, kind) => {
    const pod = sampled();
    const { batches } =
      kind === "pod"
        ? await open(
            "live",
            PODS,
            pod.namespace,
            pod.name,
            undefined,
            ANSWER_MS - 1,
          )
        : await open(
            "live",
            NODE_KIND,
            null,
            "staging-node-1",
            undefined,
            ANSWER_MS - 1,
          );
    expect(batches.length).toBeGreaterThan(0);
    expect(batches.every((batch) => batch.usage === null)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    const sent = batches.filter((batch) => batch.usage !== null);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.usage?.state).toBe("ready");
    expect(sent[0]?.usage?.cpu.used).toBeGreaterThan(0);
    expect(sent[0]?.usage?.memory.used).toBeGreaterThan(0);
  },
);

test.each([
  ["metricsDown", "unavailable"],
  ["metricsForbidden", "forbidden"],
] as const)(
  "%s: an open pod's first usage comes once its scope has answered, and says %s",
  async (scenario, state) => {
    const pod = sampled();
    const { batches } = await open(
      scenario,
      PODS,
      pod.namespace,
      pod.name,
      undefined,
      ANSWER_MS - 1,
    );
    expect(batches.every((batch) => batch.usage === null)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(batches.filter((batch) => batch.usage !== null)).toHaveLength(1);
    expect(usageOf(batches)).toMatchObject({ state, cpu: { used: null } });
  },
);

test("an object whose namespace a list already reads has its usage in its first batch", async () => {
  const backend = createMockBackend("live");
  const pods = await reader(
    backend,
    query({ sort: { column: "CPU", descending: true } }),
  );
  await pods.read();
  await pods.next();
  const pod = sampled();
  const { batches } = await openOn(
    backend,
    PODS,
    pod.namespace,
    pod.name,
    undefined,
    1,
  );
  expect(batches[0]?.usage?.state).toBe("ready");
  expect(batches[0]?.usage?.cpu.used).toBeGreaterThan(0);
  expect(batches.filter((batch) => batch.usage !== null)).toHaveLength(1);
});

test("a list over a namespace that an open pod reads has its values and state in its first batch", async () => {
  const backend = createMockBackend("live");
  const pod = sampled();
  await openOn(backend, PODS, pod.namespace, pod.name);
  const pods = await reader(backend, query({ namespaces: [pod.namespace] }));
  await pods.read();
  const [first] = pods.batches;
  expect(first?.metrics).toBe("ready");
  expect(measured(pods.cpu(first))).toBe(true);
});

function showUsage(backend: Backend, id: number, usage: boolean) {
  return call(
    backend.invoke("object_set_parts", {
      id,
      parts: {
        overview: true,
        manifest: false,
        events: false,
        related: false,
        usage,
      },
    }),
  );
}

test("a usage part shown later has its usage at once when a list holds its scope, and after the scope answers when none does", async () => {
  const pod = sampled();
  const alone = await open(
    "live",
    PODS,
    pod.namespace,
    pod.name,
    { usage: false },
    1,
  );
  await showUsage(alone.backend, alone.id, true);
  expect(alone.batches.every((batch) => batch.usage === null)).toBe(true);
  await vi.advanceTimersByTimeAsync(ANSWER_MS);
  expect(usageOf(alone.batches)?.state).toBe("ready");

  const backend = createMockBackend("live");
  const pods = await reader(
    backend,
    query({ sort: { column: "CPU", descending: true } }),
  );
  await pods.read();
  await pods.next();
  const held = await openOn(
    backend,
    PODS,
    pod.namespace,
    pod.name,
    { usage: false },
    1,
  );
  await showUsage(backend, held.id, true);
  expect(usageOf(held.batches)?.state).toBe("ready");
  expect(held.batches.filter((batch) => batch.usage !== null)).toHaveLength(1);
});

test("usage is sent again at a scrape while the part is shown, and not once it is hidden", async () => {
  const pod = sampled();
  const { backend, batches, id } = await open(
    "live",
    PODS,
    pod.namespace,
    pod.name,
  );
  const count = () => batches.filter((batch) => batch.usage !== null).length;
  expect(count()).toBe(1);
  await vi.advanceTimersByTimeAsync(SCRAPE_MS);
  expect(count()).toBe(2);
  await vi.advanceTimersByTimeAsync(SCRAPE_MS * 2);
  expect(count()).toBe(4);
  await call(
    backend.invoke("object_set_parts", {
      id,
      parts: {
        overview: true,
        manifest: false,
        events: false,
        related: false,
        usage: false,
      },
    }),
  );
  await vi.advanceTimersByTimeAsync(SCRAPE_MS * 3);
  expect(count()).toBe(4);
  expect(vi.getTimerCount()).toBe(0);
});

test("no usage is asked for, none is sent", async () => {
  const pod = sampled();
  const { batches } = await open("live", PODS, pod.namespace, pod.name, {});
  await vi.advanceTimersByTimeAsync(SCRAPE_MS * 2);
  expect(batches.every((batch) => batch.usage === null)).toBe(true);
});

async function discovered(scenario: MockScenario) {
  const backend = createMockBackend(scenario);
  const messages: Discovered[] = [];
  const pending = backend.subscribe("resources_watch", "staging", (message) =>
    messages.push(message),
  );
  await vi.advanceTimersByTimeAsync(0);
  await pending;
  return {
    messages,
    metrics: () =>
      messages.map((message) =>
        message.state === "ready"
          ? message.resources
              .filter(({ gvr }) => gvr.group === "metrics.k8s.io")
              .map(({ gvr }) => gvr.resource)
          : [],
      ),
  };
}

test("discovery lists the Metrics API's pods and nodes where the context serves it, even stale or refusing", async () => {
  for (const scenario of [
    "ready",
    "metricsDown",
    "metricsForbidden",
  ] as const) {
    const { metrics } = await discovered(scenario);
    expect(metrics(), scenario).toEqual([["nodes", "pods"]]);
  }
});

test("metricsNone's discovery has no Metrics API", async () => {
  const { metrics, messages } = await discovered("metricsNone");
  expect(messages).toHaveLength(1);
  expect(metrics()).toEqual([[]]);
});

test("metricsRemoved's discovery loses the Metrics API when the context stops serving it", async () => {
  const { metrics } = await discovered("metricsRemoved");
  expect(metrics()).toEqual([["nodes", "pods"]]);
  await vi.advanceTimersByTimeAsync(REMOVED_MS);
  expect(metrics()).toEqual([["nodes", "pods"], []]);
});

test("metricsNone has no metric columns, no state and no usage", async () => {
  const pods = await list("metricsNone");
  await pods.window(0, 40, true);
  expect(pods.columns().map((c) => c.name)).not.toContain("CPU");
  expect(pods.batches.every((batch) => batch.metrics === null)).toBe(true);
  expect(pods.shown()[0]?.cells.length).toBe(pods.columns().length);
  const pod = sampled();
  const { batches } = await open("metricsNone", PODS, pod.namespace, pod.name);
  expect(batches.every((batch) => batch.usage === null)).toBe(true);
});

const REMOVED = 20_000;

test("metricsRemoved serves the API for 20 s, then an open pod's usage is withdrawn with absent, once, and its scrapes stop", async () => {
  const pod = sampled();
  const { batches } = await open(
    "metricsRemoved",
    PODS,
    pod.namespace,
    pod.name,
  );
  const states = () =>
    batches.flatMap((batch) => (batch.usage ? [batch.usage.state] : []));
  expect(states()).toEqual(["ready"]);
  await vi.advanceTimersByTimeAsync(REMOVED - 100);
  expect(states().every((state) => state === "ready")).toBe(true);
  await vi.advanceTimersByTimeAsync(200);
  expect(states()[states().length - 1]).toBe("absent");
  expect(batches[batches.length - 1]?.usage).toMatchObject({
    sampled: null,
    cpu: { used: null },
    memory: { used: null },
    containers: [],
  });
  const count = batches.length;
  await vi.advanceTimersByTimeAsync(SCRAPE_MS * 3);
  expect(batches).toHaveLength(count);
  expect(states().filter((state) => state === "absent")).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("a usage part that was hidden when the API went hears absent once it is shown, and only once", async () => {
  const pod = sampled();
  const { backend, batches, id } = await open(
    "metricsRemoved",
    PODS,
    pod.namespace,
    pod.name,
  );
  const parts = (usage: boolean) =>
    call(
      backend.invoke("object_set_parts", {
        id,
        parts: {
          overview: true,
          manifest: false,
          events: false,
          related: false,
          usage,
        },
      }),
    );
  await parts(false);
  await vi.advanceTimersByTimeAsync(REMOVED + 1000);
  const states = () =>
    batches.flatMap((batch) => (batch.usage ? [batch.usage.state] : []));
  expect(states()).toEqual(["ready"]);
  await parts(true);
  expect(states()).toEqual(["ready", "absent"]);
  await parts(false);
  await parts(true);
  expect(states()).toEqual(["ready", "absent"]);
});

test("metricsRemoved: an open list loses its CPU and Memory columns and their cells when the API goes, a sort by them falls to Name, and a list opened later has none", async () => {
  const pods = await list(
    "metricsRemoved",
    query({ sort: { column: "CPU", descending: true } }),
  );
  await pods.window(0, 40, true);
  expect(pods.columns().map((column) => column.name)).toContain("CPU");
  expect(pods.column("CPU").some((cell) => cell !== null)).toBe(true);
  await vi.advanceTimersByTimeAsync(REMOVED);
  await pods.sync();
  await vi.advanceTimersByTimeAsync(200);
  await pods.sync();
  const names = pods.columns().map((column) => column.name);
  expect(names).not.toContain("CPU");
  expect(names).not.toContain("Memory");
  expect(pods.shown().length).toBeGreaterThan(0);
  expect(pods.shown().every((row) => row.cells.length === names.length)).toBe(
    true,
  );
  const order = pods.column("Name").map(String);
  expect(order).toEqual([...order].sort(natural));
  expect(
    [...pods.batches].reverse().find((batch) => batch.metrics !== null)
      ?.metrics,
  ).toBe("ready");

  const late = await reader(createMockBackend("metricsRemoved"), query());
  await vi.advanceTimersByTimeAsync(REMOVED);
  await late.read();
  await late.next();
  const [first] = late.batches;
  expect(first?.columns?.map((column) => column.name)).not.toContain("CPU");
});

test.each([
  ["metricsDown", "unavailable"],
  ["metricsForbidden", "forbidden"],
] as const)(
  "%s keeps the columns, leaves their cells empty and says %s",
  async (scenario, state) => {
    const pods = await list(scenario);
    await pods.window(0, 60, true);
    await pods.window(0, 60, true);
    expect(pods.columns().map((c) => c.name)).toContain("CPU");
    expect(
      [...pods.batches].reverse().find((batch) => batch.metrics !== null)
        ?.metrics,
    ).toBe(state);
    expect(pods.column("CPU").every((cell) => cell === null)).toBe(true);
    expect(pods.column("Memory").every((cell) => cell === null)).toBe(true);
    const pod = sampled();
    const { batches } = await open(scenario, PODS, pod.namespace, pod.name);
    expect(usageOf(batches)).toMatchObject({
      state,
      sampled: null,
      cpu: { used: null },
      containers: [],
    });
  },
);
