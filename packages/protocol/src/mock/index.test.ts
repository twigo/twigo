import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { KeyboardLayout, ListBatch, ListQuery } from "../generated";
import { createMockBackend, type MockScenario } from "./index";
import { natural } from "./query";

function query(rest: Partial<ListQuery> = {}): ListQuery {
  return {
    space: "prod-eu",
    gvr: { group: "", version: "v1", resource: "pods" },
    namespaced: true,
    namespaces: [],
    labelSelector: null,
    text: null,
    columns: null,
    sort: null,
    groupBy: null,
    values: null,
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
  const windowed = backend.invoke("list_set_window", { id, start: 0, end: 0 });
  await vi.advanceTimersByTimeAsync(50);
  await windowed;
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

test("lists the spaces, and the catalog colours their contexts", async () => {
  const backend = createMockBackend();
  const spaces = backend.invoke("spaces_list", null);
  const contexts = backend.subscribe("contexts_watch", null, () => undefined);
  await vi.advanceTimersByTimeAsync(0);
  const colors = new Map((await contexts).map((c) => [c.name, c.color]));
  expect(
    (await spaces).map((s) => [s.id, colors.get(s.contexts[0] ?? "")]),
  ).toEqual([
    ["prod-eu", "red"],
    ["staging", "orange"],
    ["dev", "green"],
  ]);
});

test("answers with the chosen keyboard layout, US by default, and never changes it", async () => {
  const typed = async (backend: ReturnType<typeof createMockBackend>) => {
    const changes: KeyboardLayout[] = [];
    const layout = backend.subscribe("keyboard_layout_watch", null, (l) =>
      changes.push(l),
    );
    await vi.advanceTimersByTimeAsync(5000);
    return { keyQ: (await layout).keys.KeyQ?.value, changes };
  };
  expect(await typed(createMockBackend())).toEqual({ keyQ: "q", changes: [] });
  expect(await typed(createMockBackend("live", "french"))).toEqual({
    keyQ: "a",
    changes: [],
  });
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
  await vi.advanceTimersByTimeAsync(0);
  const id = await again;
  const windowed = sub.backend.invoke("list_set_window", {
    id,
    start: 0,
    end: 40,
  });
  await vi.advanceTimersByTimeAsync(50);
  await windowed;
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

test("nothing goes before the first window, as in Rust", async () => {
  const backend = createMockBackend("ready");
  const batches: ListBatch[] = [];
  const pending = backend.subscribe("list_subscribe", query(), (b) =>
    batches.push(b),
  );
  await vi.advanceTimersByTimeAsync(0);
  const id = await pending;
  await vi.advanceTimersByTimeAsync(500);
  expect(batches).toEqual([]);
  const windowed = backend.invoke("list_set_window", { id, start: 0, end: 5 });
  await vi.advanceTimersByTimeAsync(10);
  await windowed;
  expect(batches[0]?.window?.ids).toHaveLength(5);
});

test("a window that moves past the end sends its start, though its rows stay none", async () => {
  const { batches, ack, window } = await open(
    "ready",
    query({ text: "no-such-pod" }),
  );
  await ack();
  await window(10, 20);
  await vi.advanceTimersByTimeAsync(10);
  expect(last(batches)?.window).toEqual({ start: 10, ids: [] });
  await ack();
  await window(20, 30);
  await vi.advanceTimersByTimeAsync(10);
  expect(last(batches)?.window).toEqual({ start: 20, ids: [] });
});

test("an ack with no moved window leaves the changes for the next tick", async () => {
  const sub = await open("live");
  await sub.window(0, 40);
  for (let ms = 0; ms < 1500; ms += 50) {
    await vi.advanceTimersByTimeAsync(50);
    await sub.ack();
  }
  const ready = last(sub.batches)?.seq ?? 0;
  for (let ms = 0; ms < 2000 && last(sub.batches)?.seq === ready; ms += 50) {
    await vi.advanceTimersByTimeAsync(50);
  }
  const waiting = last(sub.batches)?.seq;
  expect(waiting, "a change it does not ack").toBe(ready + 1);
  await vi.advanceTimersByTimeAsync(1100);
  expect(last(sub.batches)?.seq, "it waits for the ack").toBe(waiting);
  await sub.ack();
  await vi.advanceTimersByTimeAsync(1);
  expect(last(sub.batches)?.seq, "nothing before the tick").toBe(waiting);
  await vi.advanceTimersByTimeAsync(60);
  expect(last(sub.batches)?.seq, "the churn on the tick").toBe(ready + 2);
});

test("a window that moves while a batch waits goes out with the ack", async () => {
  const { batches, ack, window } = await open("ready");
  await window(0, 5);
  const before = last(batches)?.seq;
  await window(5, 10);
  await vi.advanceTimersByTimeAsync(1);
  expect(last(batches)?.seq, "it waits for the ack").toBe(before);
  await ack();
  await vi.advanceTimersByTimeAsync(1);
  expect(last(batches)?.window?.start, "with the ack, not the tick").toBe(5);
});

test("a window change flushes at once, without waiting for the next tick", async () => {
  const sub = await open("ready");
  await sub.ack();
  await sub.window(100, 140);
  await vi.advanceTimersByTimeAsync(1);
  expect(sub.batches.map((b) => b.seq)).toEqual([1, 2]);
  expect(sub.batches[1]?.window?.start).toBe(100);
});

test("with a rate, a live list changes that many pods a second and no more", async () => {
  const backend = createMockBackend("live", "us", 100);
  const batches: ListBatch[] = [];
  const pending = backend.subscribe(
    "list_subscribe",
    query({ space: "staging" }),
    (b) => batches.push(b),
  );
  await vi.advanceTimersByTimeAsync(0);
  const id = await pending;
  const ack = async () => {
    const latest = last(batches);
    if (latest) await call(backend.invoke("list_ack", { id, seq: latest.seq }));
  };
  await call(backend.invoke("list_set_window", { id, start: 0, end: 800 }));
  for (let ms = 0; ms < 2000; ms += 50) {
    await ack();
    await vi.advanceTimersByTimeAsync(50);
  }
  await ack();
  const from = batches.length;
  for (let ms = 0; ms < 2000; ms += 50) {
    await vi.advanceTimersByTimeAsync(50);
    await ack();
  }
  const changed = batches.slice(from).flatMap((b) => b.upserts);
  expect(changed.length).toBeGreaterThanOrEqual(190);
  expect(changed.length).toBeLessThanOrEqual(210);
  expect(last(batches)?.total).toBe(800);
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
  expect(names).toHaveLength(50);
  expect(names).toEqual([...(names ?? [])].sort((a, b) => natural(b, a)));
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

test("one namespace drops the Namespace column", async () => {
  const one = await open("ready", query({ namespaces: ["payments"] }));
  expect(one.batches[0]?.columns?.some((c) => c.name === "Namespace")).toBe(
    false,
  );
});

test("text filters match and negate", async () => {
  const hit = await open("ready", query({ text: "CrashLoopBackOff" }));
  const miss = await open("ready", query({ text: "!CrashLoopBackOff" }));
  const total = (hit.batches[0]?.total ?? 0) + (miss.batches[0]?.total ?? 0);
  expect(hit.batches[0]?.total).toBeGreaterThan(0);
  expect(total).toBe(5000);
});

test("columns come once a list knows them, from its first page, as in Rust", async () => {
  for (const [scenario, known] of [
    ["queued", false],
    ["connecting", false],
    ["forbidden", false],
    ["syncing", true],
    ["ready", true],
  ] as const) {
    const sub = await open(scenario);
    expect(
      (sub.batches[0]?.columns?.length ?? 0) > 0,
      `${scenario} knows its columns`,
    ).toBe(known);
  }
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

test("text matches the columns of priority 0 and those the query's choices show", async () => {
  const total = async (text: string, columns: Record<string, boolean> | null) =>
    (await open("ready", query({ text, columns }))).batches[0]?.total;
  expect(await total("<none>", null)).toBe(0);
  expect(await total("10.244.", null)).toBe(0);
  expect(await total("10.244.", { IP: true })).toBe(5000);
  expect(await total("kube-system", null)).toBeGreaterThan(0);
  expect(await total("kube-system", { Namespace: false })).toBe(0);
});

test("a choice for a column the list lacks does nothing", async () => {
  const one = await open(
    "ready",
    query({
      namespaces: ["payments"],
      text: "payments",
      columns: { Namespace: true, IP: true },
    }),
  );
  expect(one.batches[0]?.total).toBeGreaterThan(0);
});

test("a sort or groupBy column the list lacks does nothing", async () => {
  const plain = await open("ready");
  const odd = await open(
    "ready",
    query({ sort: { column: "Bogus", descending: true }, groupBy: "Bogus" }),
  );
  for (const sub of [plain, odd]) {
    await sub.ack();
    await sub.window(0, 10);
    await vi.advanceTimersByTimeAsync(10);
  }
  const ids = last(plain.batches)?.window?.ids;
  expect(ids).toHaveLength(10);
  expect(last(odd.batches)?.window?.ids).toEqual(ids);
  expect(odd.batches[0]?.groups).toEqual([]);
});

test("label selectors match the pods' labels, and one that does not parse is refused", async () => {
  const labelled = await open("ready", query({ labelSelector: "!app" }));
  expect(labelled.batches[0]?.total).toBe(5000);
  const none = await open("ready", query({ labelSelector: "app=api" }));
  expect(none.batches[0]?.total).toBe(0);
  const backend = createMockBackend();
  const pending = backend.subscribe(
    "list_subscribe",
    query({ labelSelector: "app in api" }),
    () => undefined,
  );
  const rejected = expect(pending).rejects.toMatchObject({
    kind: "invalidInput",
  });
  await vi.advanceTimersByTimeAsync(0);
  await rejected;
});

test("a regex that does not parse is refused at subscribe", async () => {
  const backend = createMockBackend();
  const pending = backend.subscribe(
    "list_subscribe",
    query({ text: "/web-[/" }),
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
    contexts: ["kind-local"],
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

test("state loads what was stored, all of a set or none", async () => {
  const backend = createMockBackend();
  expect(await call(backend.invoke("state_load", null))).toEqual({
    app: {},
    spaces: {},
  });
  await call(
    backend.invoke("state_set", [
      { space: null, key: "history", value: "[]" },
      { space: "prod-eu", key: "namespaces", value: '["default"]' },
    ]),
  );
  const failed = backend
    .invoke("state_set", [
      { space: null, key: "kept", value: "1" },
      { space: "nowhere", key: "lost", value: "1" },
    ])
    .catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(0);
  expect(await failed).toMatchObject({ kind: "notFound" });
  expect(await call(backend.invoke("state_load", null))).toEqual({
    app: { history: "[]" },
    spaces: { "prod-eu": { namespaces: '["default"]' } },
  });
});

test("grouped counts follow the rows once a live list syncs", async () => {
  const { batches, ack } = await open("live", query({ groupBy: "Status" }));
  for (let i = 0; i < 40; i++) {
    await ack();
    await vi.advanceTimersByTimeAsync(50);
  }
  const groups = batches.flatMap((batch) =>
    batch.groups ? [batch.groups] : [],
  );
  const latest = groups[groups.length - 1] ?? [];
  expect(latest.reduce((sum, group) => sum + group.count, 0)).toBe(5000);
});

test("a change of counts alone sends a batch with the new groups", async () => {
  const { batches, ack } = await open("live", query({ groupBy: "Status" }));
  for (let ms = 0; ms < 4000; ms += 50) {
    await ack();
    await vi.advanceTimersByTimeAsync(50);
  }
  const ready = batches.findIndex((batch) => batch.status.state === "ready");
  const after = batches.slice(ready + 1);
  expect(ready).toBeGreaterThan(0);
  expect(after.length).toBeGreaterThan(0);
  expect(after.every((batch) => batch.groups !== null)).toBe(true);
  after.forEach((batch, i) => {
    expect(batch.groups).not.toEqual(batches[ready + i]?.groups);
  });
});

test("no groupBy, no groups", async () => {
  const { batches } = await open("ready");
  expect(batches.every((batch) => batch.groups === null)).toBe(true);
});

test("values keep their rows, and the grouped counts stay those of every value", async () => {
  const all = await open("ready", query({ groupBy: "Status" }));
  const picked = await open(
    "ready",
    query({
      groupBy: "Status",
      values: { column: "Status", values: ["CrashLoopBackOff", "Error"] },
    }),
  );
  const counts = all.batches[0]?.groups ?? [];
  const count = (value: string) =>
    counts.find((group) => group.value === value)?.count ?? 0;
  expect(picked.batches[0]?.total).toBe(
    count("CrashLoopBackOff") + count("Error"),
  );
  expect(picked.batches[0]?.total).toBeGreaterThan(0);
  expect(picked.batches[0]?.groups).toEqual(counts);
});

test("values of a column the list lacks keep every row", async () => {
  const { batches } = await open(
    "ready",
    query({ values: { column: "Bogus", values: ["x"] } }),
  );
  expect(batches[0]?.total).toBe(5000);
});

test("a request for an idle plugin's credential starts its run, and only sign-in links open", async () => {
  vi.useRealTimers();
  const backend = createMockBackend("review");
  await backend.invoke("exec_trust", ["azure-prod-eu"]);
  const seen: string[] = [];
  const first = await backend.subscribe(
    "context_auth_watch",
    "prod-eu",
    (auth) => {
      if (auth.state === "plugin") seen.push(auth.status.state);
    },
  );
  expect(first).toMatchObject({ state: "plugin", status: { state: "idle" } });
  await expect(backend.invoke("cluster_version", "prod-eu")).rejects.toThrow(
    "gave no credential yet",
  );
  expect(seen).toContain("running");
  await expect(
    backend.invoke("url_open", "http://localhost:1@example.com/"),
  ).rejects.toThrow("only sign-in links");
});

test("a request runs a failed unattended plugin again, as Rust holds only a sign-in's failure", async () => {
  vi.useRealTimers();
  const backend = createMockBackend("pluginFailed");
  const seen: string[] = [];
  await backend.subscribe("context_auth_watch", "prod-eu", (auth) => {
    if (auth.state === "plugin") seen.push(auth.status.state);
  });
  await expect(backend.invoke("cluster_version", "prod-eu")).rejects.toThrow(
    "gave no credential yet",
  );
  expect(seen).toEqual(["running"]);
  await vi.waitFor(() => {
    expect(seen).toEqual(["running", "running", "failed"]);
  });
});
