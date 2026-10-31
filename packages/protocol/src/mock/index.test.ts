import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ListBatch, ListQuery } from "../generated";
import { createMockBackend, type MockScenario } from "./index";

function query(rest: Partial<ListQuery> = {}): ListQuery {
  return {
    space: "prod-eu",
    gvr: { group: "", version: "v1", resource: "pods" },
    namespaces: [],
    labelSelector: null,
    text: null,
    sort: null,
    ...rest,
  };
}

async function open(scenario: MockScenario, q: ListQuery = query()) {
  const backend = createMockBackend(scenario);
  const batches: ListBatch[] = [];
  const pending = backend.subscribe("list_subscribe", q, (b) =>
    batches.push(b),
  );
  await vi.advanceTimersByTimeAsync(0);
  const id = await pending;
  await vi.advanceTimersByTimeAsync(50);
  const ack = async () => {
    const latest = last(batches);
    if (!latest) return;
    const done = backend.invoke("list_ack", { id, seq: latest.seq });
    await vi.advanceTimersByTimeAsync(0);
    await done;
  };
  const window = async (start: number, end: number) => {
    const done = backend.invoke("list_set_window", { id, start, end });
    await vi.advanceTimersByTimeAsync(0);
    await done;
  };
  return { backend, batches, id, ack, window };
}

function last<T>(items: readonly T[]): T | undefined {
  return items[items.length - 1];
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

test("lists the spaces with their context colours", async () => {
  const backend = createMockBackend();
  const spaces = backend.invoke("spaces_list", null);
  await vi.advanceTimersByTimeAsync(0);
  expect((await spaces).map((s) => [s.id, s.contexts[0]?.color])).toEqual([
    ["prod-eu", "red"],
    ["staging", "orange"],
    ["dev", "green"],
    ["dev+qa", "green"],
  ]);
});

test("a live subscription connects, syncs and becomes ready with 5k pods; the next one starts ready", async () => {
  const sub = await open("live");
  await sub.window(0, 40);
  const states: string[] = [];
  for (let ms = 0; ms < 1500; ms += 50) {
    await vi.advanceTimersByTimeAsync(50);
    const latest = last(sub.batches);
    if (latest && last(states) !== latest.status.state) {
      states.push(latest.status.state);
    }
    await sub.ack();
  }
  expect(states).toEqual(["connecting", "syncing", "ready"]);
  const ready = last(sub.batches);
  expect(ready?.total).toBe(5000);

  const batches: ListBatch[] = [];
  const again = sub.backend.subscribe("list_subscribe", query(), (b) =>
    batches.push(b),
  );
  await vi.advanceTimersByTimeAsync(50);
  await again;
  expect(batches[0]?.status.state).toBe("ready");
});

test("no batch follows until the previous one is acknowledged, and the next carries the latest state", async () => {
  const sub = await open("ready");
  await vi.advanceTimersByTimeAsync(100);
  expect(sub.batches.map((b) => b.seq)).toEqual([1]);

  await sub.window(0, 10);
  await sub.window(20, 30);
  await vi.advanceTimersByTimeAsync(500);
  expect(sub.batches.map((b) => b.seq)).toEqual([1]);

  await sub.ack();
  await vi.advanceTimersByTimeAsync(50);
  expect(sub.batches.map((b) => b.seq)).toEqual([1, 2]);
  const second = sub.batches[1];
  expect(second?.window?.start).toBe(20);
  expect(second?.window?.ids).toHaveLength(10);
  expect(second?.upserts).toHaveLength(10);
});

test("rows come sorted by the query's column, and the first batch carries the columns", async () => {
  const sub = await open(
    "ready",
    query({ sort: { column: "Name", descending: true } }),
  );
  await sub.window(0, 50);
  await sub.ack();
  await vi.advanceTimersByTimeAsync(50);
  const names = last(sub.batches)?.upserts.map((r) => String(r.cells[0]));
  const natural = new Intl.Collator("en", { numeric: true });
  expect(names).toHaveLength(50);
  expect(names).toEqual(
    [...(names ?? [])].sort((a, b) => natural.compare(b, a)),
  );
  expect(sub.batches[0]?.columns?.map((c) => c.name)).toEqual([
    "Name",
    "Namespace",
    "Ready",
    "Status",
    "Restarts",
    "Age",
    "IP",
    "Node",
    "Nominated Node",
    "Readiness Gates",
  ]);
});

test("one namespace drops the Namespace column, and a multi-context space adds Context", async () => {
  const one = await open("ready", query({ namespaces: ["payments"] }));
  expect(one.batches[0]?.columns?.some((c) => c.name === "Namespace")).toBe(
    false,
  );
  const merged = await open("ready", query({ space: "dev+qa" }));
  expect(merged.batches[0]?.columns?.[0]?.name).toBe("Context");
});

test("text filters match and negate", async () => {
  const hit = await open("ready", query({ text: "CrashLoopBackOff" }));
  const miss = await open("ready", query({ text: "!CrashLoopBackOff" }));
  const total = (hit.batches[0]?.total ?? 0) + (miss.batches[0]?.total ?? 0);
  expect(hit.batches[0]?.total).toBeGreaterThan(0);
  expect(total).toBe(5000);
});

test("pinned states keep or drop rows as Rust does", async () => {
  for (const [scenario, total] of [
    ["relisting", 5000],
    ["stale", 5000],
    ["forbidden", 0],
    ["syncing", 0],
  ] as const) {
    const sub = await open(scenario);
    expect(sub.batches[0]?.status.state).toBe(scenario);
    expect(sub.batches[0]?.total).toBe(total);
  }
});

test("text matches the shown columns only", async () => {
  const hidden = await open("ready", query({ text: "<none>" }));
  expect(hidden.batches[0]?.total).toBe(0);
});

test("an unknown sort column is refused at subscribe", async () => {
  const backend = createMockBackend();
  const pending = backend.subscribe(
    "list_subscribe",
    query({ sort: { column: "Bogus", descending: false } }),
    () => undefined,
  );
  const rejected = expect(pending).rejects.toMatchObject({
    kind: "invalidInput",
  });
  await vi.advanceTimersByTimeAsync(0);
  await rejected;
});

test("label selectors are refused, since the mock cannot match labels", async () => {
  const backend = createMockBackend();
  const pending = backend.subscribe(
    "list_subscribe",
    query({ labelSelector: "app=api" }),
    () => undefined,
  );
  const rejected = expect(pending).rejects.toMatchObject({
    kind: "invalidInput",
  });
  await vi.advanceTimersByTimeAsync(0);
  await rejected;
});

async function call<T>(pending: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(0);
  return pending;
}

test("opening a context without a space creates its space once", async () => {
  const backend = createMockBackend();
  const before = await call(backend.invoke("spaces_list", null));
  const space = await call(backend.invoke("space_open", "kind-local"));
  expect(space).toEqual({
    id: "kind-local",
    name: "kind-local",
    contexts: [{ name: "kind-local", color: null }],
  });
  const again = await call(backend.invoke("space_open", "kind-local"));
  expect(again).toBe(space);
  const after = await call(backend.invoke("spaces_list", null));
  expect(after).toHaveLength(before.length + 1);
});

test("opening a context that has a space returns that space", async () => {
  const backend = createMockBackend();
  const space = await call(backend.invoke("space_open", "staging"));
  expect(space.id).toBe("staging");
});

test("opening an unknown context fails with notFound", async () => {
  const backend = createMockBackend();
  const failed = backend
    .invoke("space_open", "nowhere")
    .catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(0);
  expect(await failed).toMatchObject({ kind: "notFound" });
});

test("state reads back what was stored, and null before", async () => {
  const backend = createMockBackend();
  expect(await call(backend.invoke("state_get", "space/prod-eu"))).toBeNull();
  await call(
    backend.invoke("state_set", { key: "space/prod-eu", value: "{}" }),
  );
  expect(await call(backend.invoke("state_get", "space/prod-eu"))).toBe("{}");
});
