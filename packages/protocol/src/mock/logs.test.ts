import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { LogBatch, LogEntry, LogSource, LogView } from "../generated";
import { Cluster, deploymentOf, type Pod } from "./cluster";
import { MockLogs, TAB_STREAMS } from "./logs";
import type { Limits } from "./logview/buffer";
import { level } from "./logview/level";

const SOURCE: LogSource = {
  containers: { type: "default" },
  pods: null,
  since: { type: "seconds", seconds: 300 },
  previous: false,
};

const VIEW: LogView = { level: "all", filter: null, search: null, range: null };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test.each([
  ['{"level":"warn","msg":"retrying"}', "warn"],
  ['{"severity":"ERROR","msg":"x"}', "error"],
  ['{"level":50,"msg":"pino"}', "error"],
  ['{"level":30,"msg":"pino"}', "info"],
  ['level=debug msg="cache hit"', "debug"],
  ['ts=1 lvl="warning" msg=slow', "warn"],
  ["E1103 10:41:02.402135       1 reflector.go:561] failed", "error"],
  ["W1103 10:41:02.402135       1 x.go:1] slow", "warn"],
  ["[WARN] queue depth 120", "warn"],
  ["INFO: started", "info"],
  ["panic: dial tcp: connection refused", "error"],
  ["GET /healthz 200 3ms", null],
  ["{not json and no level}", null],
])("the level of %s is %s", (line, wanted) => {
  expect(level(line)).toBe(wanted);
});

function session(
  view: LogView = VIEW,
  budget = (_session: MockLogs, wanted: number) => wanted,
  limits?: Limits,
) {
  const cluster = new Cluster("prod-eu", 5000, Date.now());
  const counts = new Map<string, number>();
  for (const pod of cluster.pods) {
    const key = `${pod.namespace}/${deploymentOf(pod)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const [busiest] = [...counts].sort((a, b) => b[1] - a[1]);
  const [namespace = "", name = ""] = (busiest?.[0] ?? "").split("/");
  const batches: LogBatch[] = [];
  const logs = new MockLogs(
    {
      space: "prod-eu",
      gvr: { group: "apps", version: "v1", resource: "deployments" },
      namespace,
      name,
    },
    SOURCE,
    view,
    cluster,
    budget,
    (batch) => {
      batches.push(batch);
      logs.ack(batch.seq);
    },
    limits,
  );
  logs.setWindow({ type: "tail", count: 200 });
  return { logs, batches, cluster, pods: busiest?.[1] ?? 0 };
}

test("a workload's tab follows ten of its pods and tells the rest are over the limit", async () => {
  const { logs, batches, pods } = session();
  await vi.advanceTimersByTimeAsync(300);
  const listed = batches.find((batch) => batch.pods !== null)?.pods ?? [];
  const states = listed.flatMap((pod) =>
    pod.containers.map((container) => container.stream.state),
  );
  expect(pods).toBeGreaterThan(TAB_STREAMS);
  expect(listed).toHaveLength(pods);
  expect(
    states.filter((state) => state !== "off" && state !== "overLimit"),
  ).toHaveLength(TAB_STREAMS);
  expect(states).toContain("overLimit");
  logs.close();
});

test("a filter keeps the matching lines and every marker, and a search marks its matches", async () => {
  const { logs, batches } = session({
    ...VIEW,
    filter: "request served",
    search: "STATUS=",
  });
  await vi.advanceTimersByTimeAsync(300);
  const last = batches[batches.length - 1];
  const entries = last?.window?.entries ?? [];
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) {
    if (entry.type !== "line") continue;
    expect(entry.text).toContain("request served");
    for (const mark of entry.marks)
      expect(entry.text.slice(mark.start, mark.end)).toBe("status=");
  }
  const marked = entries.reduce(
    (sum, entry) => sum + (entry.type === "line" ? entry.marks.length : 0),
    0,
  );
  expect(last?.matches?.count).toBeGreaterThanOrEqual(marked);
  expect(last?.matches?.entries).toHaveLength(last?.matches?.count ?? -1);
  logs.close();
});

test("the warn level keeps warnings and errors", async () => {
  const { logs, batches } = session({ ...VIEW, level: "warn" });
  await vi.advanceTimersByTimeAsync(300);
  const lines = (batches[batches.length - 1]?.window?.entries ?? []).filter(
    (entry) => entry.type === "line",
  );
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) expect(["warn", "error"]).toContain(line.level);
  logs.close();
});

test("a rollout replaces a followed pod: its followed containers end, it leaves, and its successor joins from its ReplicaSet", async () => {
  const { logs, batches } = session();
  await vi.advanceTimersByTimeAsync(26_000);
  const at = batches.findIndex((batch) =>
    batch.window?.entries.some((entry) => entry.type === "left"),
  );
  const entries = batches[at]?.window?.entries ?? [];
  const left = entries.findIndex((entry) => entry.type === "left");
  const pod = entries[left]?.type === "left" ? entries[left].pod : "";
  const listed = batches
    .slice(0, at)
    .filter((batch) => batch.pods !== null)
    .pop()
    ?.pods?.find((each) => each.name === pod);
  const following = (listed?.containers ?? [])
    .filter((container) => container.stream.state === "following")
    .map((container) => container.name);
  const ended = entries
    .slice(0, left)
    .flatMap((entry) =>
      entry.type === "ended" && entry.pod === pod && entry.exitCode === 0
        ? [entry.container]
        : [],
    );
  const after = entries
    .slice(left + 1)
    .filter((entry) => entry.type === "line" && entry.pod === pod);
  const joined = entries.find((entry) => entry.type === "joined");
  expect(following).toEqual(["api"]);
  expect(ended).toEqual(following);
  expect(after).toEqual([]);
  expect(joined?.type === "joined" && joined.owner?.kind).toBe("ReplicaSet");
  logs.close();
});

function podOf(entry: LogEntry | undefined): string | undefined {
  return entry && entry.type !== "dropped" ? entry.pod : undefined;
}

function bounds(entries: readonly LogEntry[], mark: number): void {
  const entry = entries[mark];
  const pod = podOf(entry);
  const own = entries.flatMap((each, at) =>
    podOf(each) === pod && (each.type === "line" || each.type === "ended")
      ? [at]
      : [],
  );
  if (entry?.type === "joined") {
    expect(own.every((at) => at > mark)).toBe(true);
    if (own.length > 0) expect(own[0]).toBe(mark + 1);
  } else {
    expect(entry?.type).toBe("left");
    expect(own.every((at) => at < mark)).toBe(true);
    if (own.length > 0) expect(own[own.length - 1]).toBe(mark - 1);
  }
}

test("a rollout's left stands just after its pod's last entry, and its successor's joined just before its first", async () => {
  const { logs, batches } = session();
  await vi.advanceTimersByTimeAsync(27_000);
  const entries = batches[batches.length - 1]?.window?.entries ?? [];
  const left = entries.findIndex((entry) => entry.type === "left");
  const joined = entries.findIndex((entry) => entry.type === "joined");
  expect(left).toBeGreaterThan(0);
  expect(joined).toBeGreaterThan(0);
  bounds(entries, left);
  bounds(entries, joined);
  expect(entries[joined + 1]?.type).toBe("line");
  logs.close();
});

test("only pods the source reads come and go: a read pod's rollout leaves, and its successor, which it does not read, does not join", async () => {
  const { logs, batches } = session();
  await vi.advanceTimersByTimeAsync(300);
  const read = batches.find((batch) => batch.pods !== null)?.pods?.[0]?.name;
  logs.setSource({ ...SOURCE, pods: read === undefined ? [] : [read] });
  await vi.advanceTimersByTimeAsync(27_000);
  const entries = batches[batches.length - 1]?.window?.entries ?? [];
  expect(entries.filter((entry) => entry.type === "left").map(podOf)).toEqual([
    read,
  ]);
  expect(entries.filter((entry) => entry.type === "joined")).toEqual([]);
  logs.close();
});

test("a pod that joins and writes nothing keeps its joined through the bound", async () => {
  const { logs, batches } = session(VIEW, (_session, wanted) => wanted - 1, {
    entries: 40,
    bytes: 1 << 20,
  });
  await vi.advanceTimersByTimeAsync(45_000);
  const entries = batches[batches.length - 1]?.window?.entries ?? [];
  const joined = entries.filter((entry) => entry.type === "joined");
  expect(entries[0]?.type).toBe("dropped");
  expect(joined).toHaveLength(1);
  const pod = podOf(joined[0]);
  expect(
    entries.some((entry) => entry.type === "line" && entry.pod === pod),
  ).toBe(false);
  logs.close();
});

test("a pod whose last line is the oldest the bound keeps still shows its left when it leaves as another joins", async () => {
  vi.setSystemTime(Date.UTC(2026, 10, 3, 10, 0, 0));
  let cut = false;
  const { logs, batches, cluster } = session(
    VIEW,
    (_session, wanted) => (cut ? 1 : wanted),
    { entries: 10, bytes: 1 << 20 },
  );
  await vi.advanceTimersByTimeAsync(2_000);
  const listed = batches.find((batch) => batch.pods !== null)?.pods ?? [];
  const quiet = listed
    .filter((pod) =>
      pod.containers.some(
        (container) => container.stream.state === "following",
      ),
    )
    .pop()?.name;
  cut = true;
  const oldest = () => {
    const entries = batches[batches.length - 1]?.window?.entries ?? [];
    return (
      entries[0]?.type === "dropped" &&
      podOf(entries[1]) === quiet &&
      !entries.slice(2).some((entry) => podOf(entry) === quiet)
    );
  };
  for (let tick = 0; tick < 150 && !oldest(); tick++)
    await vi.advanceTimersByTimeAsync(100);
  expect(oldest()).toBe(true);
  const pod = cluster.pods.find((each) => each.name === quiet);
  if (!pod) throw new Error("no quiet pod");
  cluster.rollOut(pod, Date.now());
  await vi.advanceTimersByTimeAsync(100);
  const entries = batches[batches.length - 1]?.window?.entries ?? [];
  expect(entries.filter((entry) => entry.type === "left").map(podOf)).toEqual([
    quiet,
  ]);
  logs.close();
});

test("a pod that leaves in its crash loop's back-off has its left just after its end", async () => {
  const cluster = new Cluster("prod-eu", 5000, Date.now());
  const pods = (pod: Pod) =>
    cluster.pods.filter(
      (each) =>
        each.namespace === pod.namespace &&
        deploymentOf(each) === deploymentOf(pod),
    );
  const crashing = cluster.pods.find((pod) => {
    const followed = pods(pod).slice(0, TAB_STREAMS);
    return (
      pod.status === "CrashLoopBackOff" &&
      followed.includes(pod) &&
      followed.some((each) => each.status === "Running")
    );
  });
  expect(crashing).toBeDefined();
  if (!crashing) return;
  const batches: LogBatch[] = [];
  const logs = new MockLogs(
    {
      space: "prod-eu",
      gvr: { group: "apps", version: "v1", resource: "deployments" },
      namespace: crashing.namespace,
      name: deploymentOf(crashing),
    },
    SOURCE,
    VIEW,
    cluster,
    (_session, wanted) => wanted,
    (batch) => {
      batches.push(batch);
      logs.ack(batch.seq);
    },
  );
  logs.setWindow({ type: "tail", count: 1000 });
  const backingOff = () =>
    batches
      .filter((batch) => batch.pods !== null)
      .pop()
      ?.pods?.find((pod) => pod.name === crashing.name)
      ?.containers.some(
        (container) =>
          container.stream.state === "waiting" &&
          container.stream.reason === "CrashLoopBackOff",
      );
  await vi.advanceTimersByTimeAsync(200);
  while (!backingOff()) await vi.advanceTimersByTimeAsync(100);
  await vi.advanceTimersByTimeAsync(5_000);
  cluster.rollOut(crashing, Date.now());
  await vi.advanceTimersByTimeAsync(200);
  const entries = batches[batches.length - 1]?.window?.entries ?? [];
  const left = entries.findIndex(
    (entry) => entry.type === "left" && entry.pod === crashing.name,
  );
  expect(entries[left - 1]?.type).toBe("ended");
  bounds(entries, left);
  expect(entries.slice(left + 1).some((entry) => entry.type === "line")).toBe(
    true,
  );
  logs.close();
});

test("a rollout of a pod whose streams are queued gives its left without an end", async () => {
  const { logs, batches } = session(VIEW, () => 0);
  await vi.advanceTimersByTimeAsync(26_000);
  const states = (batches.find((batch) => batch.pods !== null)?.pods ?? [])
    .flatMap((pod) => pod.containers.map((container) => container.stream.state))
    .filter((state) => state !== "off" && state !== "overLimit");
  const entries = batches.flatMap((batch) => batch.window?.entries ?? []);
  expect(states).toEqual(Array(TAB_STREAMS).fill("queued"));
  expect(entries.some((entry) => entry.type === "left")).toBe(true);
  expect(entries.filter((entry) => entry.type === "ended")).toEqual([]);
  logs.close();
});

test("a search or a filter that is no regex is refused", () => {
  expect(() => session({ ...VIEW, search: "/(/" })).toThrow(/no regex/);
});

test("arrived counts the entries the view kept as they came, and starts again with a new view", async () => {
  const { logs, batches } = session();
  await vi.advanceTimersByTimeAsync(3_000);
  const first = batches[batches.length - 1]?.arrived ?? 0;
  expect(first).toBeGreaterThan(0);
  await vi.advanceTimersByTimeAsync(3_000);
  const second = batches[batches.length - 1]?.arrived ?? 0;
  expect(second).toBeGreaterThan(first);
  logs.setView({ ...VIEW, filter: "no line says this" });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(batches[batches.length - 1]?.arrived).toBe(0);
  logs.close();
});

test("a crash loop's end comes without its next start, which a later batch gives it under the same id", async () => {
  const cluster = new Cluster("prod-eu", 5000, Date.now());
  const pod = cluster.pods.find((each) => each.status === "CrashLoopBackOff");
  expect(pod).toBeDefined();
  const batches: LogBatch[] = [];
  const logs = new MockLogs(
    {
      space: "prod-eu",
      gvr: { group: "", version: "v1", resource: "pods" },
      namespace: pod?.namespace ?? "",
      name: pod?.name ?? "",
    },
    SOURCE,
    VIEW,
    cluster,
    (_session, wanted) => wanted,
    (batch) => {
      batches.push(batch);
      logs.ack(batch.seq);
    },
  );
  logs.setWindow({ type: "tail", count: 200 });
  await vi.advanceTimersByTimeAsync(120_000);
  const first = new Map<number, string | null>();
  const last = new Map<number, { time: string; restarting: string | null }>();
  for (const entry of batches.flatMap((batch) => batch.window?.entries ?? [])) {
    if (entry.type !== "ended") continue;
    if (!first.has(entry.id)) first.set(entry.id, entry.restarting);
    last.set(entry.id, entry);
  }
  expect([...first.values()].every((restarting) => restarting === null)).toBe(
    true,
  );
  const told = [...last.values()].filter((end) => end.restarting !== null);
  expect(told.length).toBeGreaterThan(0);
  for (const { time, restarting } of told) {
    expect(Date.parse(restarting ?? "") - Date.parse(time)).toBe(40_000);
  }
  logs.close();
});

test("a batch counts every source and view change applied, a no-op among them", async () => {
  const { logs, batches } = session();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(batches[batches.length - 1]?.changes).toBe(0);
  logs.setView(VIEW);
  logs.setView(VIEW);
  logs.setSource(SOURCE);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(batches[batches.length - 1]?.changes).toBe(3);
  expect(() => {
    logs.setView({ ...VIEW, search: "/(/" });
  }).toThrow(/no regex/);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(batches[batches.length - 1]?.changes).toBe(3);
  logs.close();
});

test("an around window reads the entries before one and from it on, by its id", async () => {
  const { logs, batches } = session();
  await vi.advanceTimersByTimeAsync(3_000);
  const tail = batches[batches.length - 1]?.window?.entries ?? [];
  const anchor = tail[tail.length - 5];
  expect(anchor).toBeDefined();
  logs.setWindow({ type: "around", id: anchor?.id ?? 0, before: 2, after: 3 });
  await vi.advanceTimersByTimeAsync(200);
  const ids = batches[batches.length - 1]?.window?.entries.map(
    (entry) => entry.id,
  );
  expect(ids).toHaveLength(5);
  expect(ids?.[2]).toBe(anchor?.id);
  logs.close();
});
