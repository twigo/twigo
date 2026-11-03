import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { LogBatch, LogSource, LogView } from "../generated";
import { Cluster, deploymentOf } from "./cluster";
import { MockLogs, TAB_STREAMS } from "./logs";
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

function session(view: LogView = VIEW) {
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
    (_session, wanted) => wanted,
    (batch) => {
      batches.push(batch);
      logs.ack(batch.seq);
    },
  );
  logs.setWindow({ type: "tail", count: 200 });
  return { logs, batches, pods: busiest?.[1] ?? 0 };
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
