import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  Context,
  Field,
  KeyboardLayout,
  ListBatch,
  ListQuery,
  ObjectBatch,
  ObjectParts,
  Overview,
  Section,
} from "../generated";
import {
  Cluster,
  containerOf,
  deploymentOf,
  finishedAt,
  imageOf,
  podCells,
  type Pod,
} from "./cluster";
import { POD_COUNT } from "./fixtures";
import { createMockBackend, type MockScenario } from "./index";
import { deployments, KINDS, uid } from "./kinds";
import { finishedInit, MockObject } from "./objects";
import { natural } from "./query";
import { fieldText } from "./sections";

function query(rest: Partial<ListQuery> = {}): ListQuery {
  return {
    space: "prod-eu",
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

async function open(scenario: MockScenario, q: ListQuery = query()) {
  const backend = createMockBackend(scenario);
  const batches: ListBatch[] = [];
  const pending = backend.subscribe("list_subscribe", q, (b) =>
    batches.push(b),
  );
  await vi.advanceTimersByTimeAsync(0);
  const id = await pending;
  const windowed = backend.invoke("list_set_window", {
    id,
    start: 0,
    end: 0,
    metrics: false,
  });
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
    const done = backend.invoke("list_set_window", {
      id,
      start,
      end,
      metrics: false,
    });
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

test("a context's mode follows its type, a choice over it, and an unlock that ends by itself", async () => {
  const backend = createMockBackend();
  const seen: Context[][] = [];
  const first = backend.subscribe("contexts_watch", null, (next) =>
    seen.push(next),
  );
  await vi.advanceTimersByTimeAsync(0);
  const access = (contexts: Context[] | undefined, name: string) =>
    contexts?.find((context) => context.name === name)?.access;
  const latest = () => seen[seen.length - 1];
  const send = async <T>(answer: Promise<T>) => {
    await vi.advanceTimersByTimeAsync(0);
    return answer;
  };

  expect(access(await first, "prod-eu")?.mode).toBe("read-only");
  expect(access(await first, "staging")?.mode).toBe("guarded");
  expect(access(await first, "dev")?.mode).toBe("read-write");
  expect(access(await first, "qa")?.source).toEqual({ kind: "default" });

  await send(backend.invoke("context_unlock", "prod-eu"));
  const unlocked = access(latest(), "prod-eu");
  expect(unlocked?.mode).toBe("guarded");
  expect(unlocked?.source).toEqual({
    kind: "environment",
    environment: "production",
  });
  expect(unlocked?.unlockedUntil).toBe(Date.now() + 15 * 60 * 1000);

  await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1);
  expect(access(latest(), "prod-eu")?.mode).toBe("read-only");
  expect(access(latest(), "prod-eu")?.unlockedUntil).toBeNull();

  await send(
    backend.invoke("context_mode_set", { context: "qa", mode: "read-only" }),
  );
  expect(access(latest(), "qa")?.source).toEqual({ kind: "user" });
  await send(
    backend.invoke("context_environment_set", {
      context: "dev",
      environment: "production",
    }),
  );
  expect(access(latest(), "dev")?.mode).toBe("read-only");
  await send(
    backend.invoke("context_environment_set", {
      context: "dev",
      environment: null,
    }),
  );
  expect(access(latest(), "dev")?.environment).toBeNull();

  await send(backend.invoke("context_unlock", "prod-eu"));
  await send(
    backend.invoke("context_environment_set", {
      context: "prod-eu",
      environment: "local",
    }),
  );
  await send(
    backend.invoke("context_environment_set", {
      context: "prod-eu",
      environment: "production",
    }),
  );
  expect(access(latest(), "prod-eu")?.mode).toBe("read-only");
  expect(access(latest(), "prod-eu")?.unlockedUntil).toBeNull();

  const refused = expect(
    backend.invoke("context_unlock", "staging"),
  ).rejects.toMatchObject({ kind: "invalidInput" });
  const unlisted = expect(
    backend.invoke("context_mode_set", { context: "ghost", mode: "guarded" }),
  ).rejects.toMatchObject({ kind: "notFound" });
  await vi.advanceTimersByTimeAsync(0);
  await refused;
  await unlisted;
});

test("an admin's policy file holds its contexts and leaves the others", async () => {
  const backend = createMockBackend("policyFile");
  const first = backend.subscribe("contexts_watch", null, () => undefined);
  await vi.advanceTimersByTimeAsync(0);
  const prod = (await first).find((context) => context.name === "prod-eu");
  expect(prod?.access.source.kind).toBe("policyFile");

  const refused = [
    backend.invoke("context_mode_set", {
      context: "prod-eu",
      mode: "read-write",
    }),
    backend.invoke("context_unlock", "prod-eu"),
  ];
  const settled = Promise.allSettled(refused);
  await vi.advanceTimersByTimeAsync(0);
  for (const answer of await settled) {
    expect(answer).toMatchObject({
      status: "rejected",
      reason: { kind: "permissions" },
    });
  }
  const dev = backend.invoke("context_mode_set", {
    context: "dev",
    mode: "guarded",
  });
  await vi.advanceTimersByTimeAsync(0);
  await dev;
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
    metrics: false,
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
  const windowed = backend.invoke("list_set_window", {
    id,
    start: 0,
    end: 5,
    metrics: false,
  });
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
  await call(
    backend.invoke("list_set_window", {
      id,
      start: 0,
      end: 800,
      metrics: false,
    }),
  );
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

test("a live list of events sends a row again only when its event repeated", async () => {
  const sub = await open(
    "live",
    query({
      gvr: { group: "", version: "v1", resource: "events" },
      sort: { column: "Last Seen", descending: false },
    }),
  );
  await sub.window(0, 50);
  for (let ms = 0; ms < 1500; ms += 50) {
    await vi.advanceTimersByTimeAsync(50);
    await sub.ack();
  }
  const from = sub.batches.length;
  for (let second = 0; second < 10; second++) {
    await vi.advanceTimersByTimeAsync(1000);
    await sub.ack();
  }
  const names = sub.batches
    .find((batch) => batch.columns?.length)
    ?.columns?.map((column) => column.name);
  const count = names?.indexOf("Count") ?? -1;
  expect(count).toBeGreaterThan(-1);
  const counted = new Map<string, unknown>();
  const unrepeated: string[] = [];
  sub.batches.forEach((batch, at) => {
    for (const row of batch.upserts) {
      if (at >= from && counted.get(row.id) === row.cells[count])
        unrepeated.push(row.id);
      counted.set(row.id, row.cells[count]);
    }
  });
  expect(counted.size).toBeGreaterThanOrEqual(50);
  expect(unrepeated).toEqual([]);
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
    "CPU",
    "Memory",
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

test("columns come once a list knows them, from its first page, and an empty list before, as in Rust", async () => {
  for (const [scenario, known] of [
    ["queued", false],
    ["connecting", false],
    ["forbidden", false],
    ["syncing", true],
    ["ready", true],
  ] as const) {
    const sub = await open(scenario);
    expect(
      sub.batches[0]?.columns?.map((column) => column.name),
      `${scenario} knows its columns`,
    ).toEqual(known ? expect.arrayContaining(["Name"]) : []);
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

test("a forbidden list names its resource; live, prod-eu may not list nodes, staging may", async () => {
  const nodes = {
    gvr: { group: "", version: "v1", resource: "nodes" },
    namespaced: false,
  };
  const pinned = await open("forbidden", query(nodes));
  expect(pinned.batches[0]?.status).toEqual({
    state: "forbidden",
    verb: "list",
    resource: "nodes",
  });
  const prod = await open("live", query(nodes));
  expect(prod.batches[0]?.status.state).toBe("forbidden");
  const staging = await open("live", query({ ...nodes, space: "staging" }));
  await staging.window(0, 50);
  for (let ms = 0; ms < 1500; ms += 50) {
    await staging.ack();
    await vi.advanceTimersByTimeAsync(50);
  }
  const latest = last(staging.batches);
  expect(latest?.status.state).toBe("ready");
  expect(latest?.total).toBe(40);
});

test("nodes, deployments and events come behind the same query view as pods", async () => {
  const deployments = await open(
    "ready",
    query({
      gvr: { group: "apps", version: "v1", resource: "deployments" },
      countBy: "Ready",
    }),
  );
  expect(deployments.batches[0]?.columns?.map((column) => column.name)).toEqual(
    [
      "Name",
      "Namespace",
      "Ready",
      "Up-to-date",
      "Available",
      "Age",
      "Containers",
      "Images",
      "Selector",
    ],
  );
  expect(
    deployments.batches[0]?.counts?.reduce(
      (sum, value) => sum + value.count,
      0,
    ),
  ).toBe(deployments.batches[0]?.total);
  const warnings = await open(
    "ready",
    query({
      gvr: { group: "", version: "v1", resource: "events" },
      countBy: "Type",
    }),
  );
  expect(
    warnings.batches[0]?.counts?.find((value) => value.value === "Warning")
      ?.count,
  ).toBeGreaterThan(0);
  const refused = createMockBackend("ready")
    .subscribe(
      "list_subscribe",
      query({ gvr: { group: "", version: "v1", resource: "secrets" } }),
      () => undefined,
    )
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  expect(await refused).toMatchObject({ kind: "notFound" });
});

test("text matches the columns of priority 0 and those the query's choices show", async () => {
  const total = async (text: string, columns: Record<string, boolean> | null) =>
    (await open("ready", query({ text, columns }))).batches[0]?.total;
  expect(await total("<none>", null)).toBe(0);
  expect(await total("10.244.", null)).toBe(0);
  const scheduled = new Cluster("prod-eu", 5000, Date.now()).pods.filter(
    (pod) => pod.status !== "Pending",
  ).length;
  expect(await total("10.244.", { IP: true })).toBe(scheduled);
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

test("a sort or countBy column the list lacks does nothing", async () => {
  const plain = await open("ready");
  const odd = await open(
    "ready",
    query({ sort: { column: "Bogus", descending: true }, countBy: "Bogus" }),
  );
  for (const sub of [plain, odd]) {
    await sub.ack();
    await sub.window(0, 10);
    await vi.advanceTimersByTimeAsync(10);
  }
  const ids = last(plain.batches)?.window?.ids;
  expect(ids).toHaveLength(10);
  expect(last(odd.batches)?.window?.ids).toEqual(ids);
  expect(odd.batches[0]?.counts).toEqual([]);
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

test("a field selector keeps the pods of one node, and one on a field pods lack fails the list as the server does", async () => {
  const pods = new Cluster("prod-eu", 5000, Date.now()).pods;
  const node = pods[0]?.node ?? "";
  const on = await open(
    "ready",
    query({ fieldSelector: `spec.nodeName=${node},` }),
  );
  expect(on.batches[0]?.total).toBe(
    pods.filter((pod) => pod.node === node && pod.status !== "Pending").length,
  );
  const off = await open(
    "ready",
    query({
      fieldSelector: `spec.nodeName!=${node},spec.restartPolicy=Always`,
    }),
  );
  expect(off.batches[0]?.total).toBe(
    pods.filter((pod) => pod.node !== node || pod.status === "Pending").length,
  );
  const wrong = await open(
    "ready",
    query({ fieldSelector: "spec.containers=api" }),
  );
  expect(wrong.batches[0]?.status).toEqual({
    state: "error",
    error: {
      kind: "invalidInput",
      message: "field label not supported: spec.containers",
    },
  });
  expect(wrong.batches[0]?.total).toBe(0);
});

test("a field selector takes old names and fields the server matches as empty, and refuses what does not parse", async () => {
  const pods = new Cluster("prod-eu", 5000, Date.now()).pods;
  const node = pods[0]?.node ?? "";
  const old = await open(
    "ready",
    query({ fieldSelector: `spec.host=${node}` }),
  );
  expect(old.batches[0]?.total).toBe(
    pods.filter((pod) => pod.node === node && pod.status !== "Pending").length,
  );
  const empty = await open("ready", query({ fieldSelector: "status.podIPs=" }));
  expect(empty.batches[0]?.total).toBe(5000);
  const completed = pods.find((pod) => pod.status === "Completed");
  const running = await open(
    "ready",
    query({
      fieldSelector: `status.phase=Running,metadata.name=${completed?.name ?? ""}`,
    }),
  );
  expect(running.batches[0]?.total).toBe(1);
  const broken = await open(
    "ready",
    query({ fieldSelector: "spec.foo=1,spec.nodeName" }),
  );
  expect(broken.batches[0]?.status).toMatchObject({
    state: "error",
    error: {
      kind: "invalidInput",
      message:
        "invalid selector: 'spec.foo=1,spec.nodeName'; can't understand 'spec.nodeName'",
    },
  });
  const unsorted = await open(
    "ready",
    query({ fieldSelector: "spec.foo=1,metadata.bar=2" }),
  );
  expect(unsorted.batches[0]?.status).toMatchObject({
    error: { message: "field label not supported: metadata.bar" },
  });
  const pending = pods.find((pod) => pod.status === "Pending");
  const unscheduled = await open(
    "ready",
    query({
      fieldSelector: `spec.nodeName=${pending?.node ?? ""},metadata.name=${pending?.name ?? ""}`,
    }),
  );
  expect(unscheduled.batches[0]?.total).toBe(0);
});

test("a pod that churn puts in a Deployment with a new hash joins its live list", () => {
  const cluster = new Cluster("prod-eu", 5000, Date.now());
  const pod = cluster.pods[0];
  if (!pod) throw new Error("a pod");
  const deployment = deploymentOf(pod);
  let owners: readonly string[] = [];
  new MockObject(
    {
      space: "prod-eu",
      gvr: { group: "apps", version: "v1", resource: "deployments" },
      namespaced: true,
      namespace: pod.namespace,
      name: deployment,
    },
    OVERVIEW,
    cluster,
    (batch) => {
      for (const section of batch.overview?.sections ?? [])
        for (const block of section.blocks)
          if (block.type === "list") owners = block.owners ?? [];
    },
  );
  vi.advanceTimersByTime(1);
  cluster.pods.push({
    ...pod,
    id: `${pod.id}-new`,
    name: `${deployment}-zzzzzzzz-new01`,
    generateName: `${deployment}-zzzzzzzz-`,
    templateHash: "zzzzzzzz",
  });
  const rows = KINDS["/v1/pods"]?.rows(cluster, false) ?? [];
  const listed = rows.filter(
    (row) => row.controller !== null && owners.includes(row.controller),
  );
  expect(listed.map((row) => row.id)).toContain(`${pod.id}-new`);
});

const OVERVIEW: ObjectParts = {
  overview: true,
  manifest: false,
  events: false,
  related: false,
  usage: false,
};

async function described(
  resource: string,
  group: string,
  namespace: string,
  name: string,
): Promise<ObjectBatch> {
  const backend = createMockBackend("ready");
  const batches: ObjectBatch[] = [];
  const pending = backend.subscribe(
    "object_open",
    {
      object: {
        space: "prod-eu",
        gvr: { group, version: "v1", resource },
        namespaced: true,
        namespace,
        name,
      },
      parts: OVERVIEW,
    },
    (batch) => batches.push(batch),
  );
  await vi.advanceTimersByTimeAsync(10);
  await pending;
  const first = batches[0];
  if (!first) throw new Error("no batch");
  return first;
}

test("a mock pod opens as the recorded pod in its state", async () => {
  const pods = new Cluster("prod-eu", 5000, Date.now()).pods;
  const crashing = pods.find((pod) => pod.status === "CrashLoopBackOff");
  const running = pods.find(
    (pod) => pod.status === "Running" && pod.ready === pod.containers,
  );
  if (!crashing || !running) throw new Error("prod-eu has both");
  const broken = await described("pods", "", crashing.namespace, crashing.name);
  expect(broken.overview?.sections[0]?.id).toBe("core.diagnostics");
  const healthy = await described("pods", "", running.namespace, running.name);
  expect(healthy.overview?.sections[0]?.id).toBe("core.containers");
  const completed = pods.find((pod) => pod.status === "Completed");
  if (!completed) throw new Error("prod-eu has a completed pod");
  const done = await described("pods", "", completed.namespace, completed.name);
  expect(done.overview?.sections[0]?.id).toBe("core.containers");
});

test("a mock pod's header says what its list row prints, whatever fixture stands for it", async () => {
  const cluster = new Cluster("prod-eu", 5000, Date.now());
  const states = [
    "Running",
    "CrashLoopBackOff",
    "Pending",
    "ImagePullBackOff",
    "Completed",
  ];
  for (const status of states) {
    const pod = cluster.pods.find((candidate) => candidate.status === status);
    if (!pod) throw new Error(`prod-eu has a ${status} pod`);
    const header = (await described("pods", "", pod.namespace, pod.name))
      .overview?.header;
    const row = podCells(pod, false);
    const cell = (name: string) =>
      header?.printed.find((printed) => printed.column === name)?.value;
    expect(cell("Ready"), status).toBe(row[1]);
    expect(cell("Status"), status).toBe(row[2]);
    expect(cell("Restarts"), status).toBe(row[3]);
    expect(cell("Node"), status).toBe(
      status === "Pending" ? undefined : row[6],
    );
    expect(header?.node, status).toBe(status === "Pending" ? null : pod.node);
    expect(header?.owner?.name, status).toBe(deploymentOf(pod));
    expect(header?.vitals[0]?.value, status).toMatchObject({
      text: `${String(pod.ready)}/${String(pod.containers)}`,
    });
  }
});

test("a mock pod that has no finding says its own vitals in words, with its last restart as a time", async () => {
  const cluster = new Cluster("prod-eu", 5000, Date.now());
  const pod = cluster.pods.find(
    (candidate) =>
      candidate.status === "Running" &&
      candidate.ready === candidate.containers &&
      candidate.lastRestart !== null,
  );
  const quiet = cluster.pods.find(
    (candidate) =>
      candidate.status === "Running" &&
      candidate.ready === candidate.containers &&
      candidate.lastRestart === null,
  );
  if (!pod || !quiet) throw new Error("prod-eu has both");
  const header = (await described("pods", "", pod.namespace, pod.name)).overview
    ?.header;
  const restarts = Number.parseInt(pod.restarts, 10);
  expect(header?.sentence).toEqual([
    {
      type: "text",
      text: `${String(pod.ready)}/${String(pod.containers)} ready · ${String(restarts)} restart${restarts === 1 ? "" : "s"}, last `,
    },
    { type: "ago", at: new Date(pod.lastRestart ?? 0).toISOString() },
  ]);
  expect(header?.vitals[1]).toMatchObject({
    label: "Restarts",
    value: { type: "text", text: String(restarts) },
    note: [{ type: "ago" }],
  });
  const calm = (await described("pods", "", quiet.namespace, quiet.name))
    .overview?.header;
  expect(calm?.sentence).toEqual([
    {
      type: "text",
      text: `${String(quiet.ready)}/${String(quiet.containers)} ready · no restarts`,
    },
  ]);
  const broken = cluster.pods.find((p) => p.status === "CrashLoopBackOff");
  if (!broken) throw new Error("prod-eu has a crashing pod");
  const crash = (await described("pods", "", broken.namespace, broken.name))
    .overview?.header;
  expect(crash?.sentence).toEqual([
    { type: "text", text: `Container ${containerOf(broken)} keeps crashing` },
  ]);
  expect(crash?.vitals[1]?.value).toMatchObject({
    type: "toned",
    tone: "warning",
  });
});

test("a mock Deployment lists the mock pods of its ReplicaSets", async () => {
  const pods = new Cluster("prod-eu", 5000, Date.now()).pods;
  const pod = pods[0];
  if (!pod) throw new Error("a pod");
  const name = pod.generateName.slice(0, -`${pod.templateHash}-`.length - 1);
  const batch = await described("deployments", "apps", pod.namespace, name);
  const list = batch.overview?.sections
    .flatMap((section) => section.blocks)
    .find((block) => block.type === "list");
  if (list?.type !== "list") throw new Error("a live list");
  expect(list.namespace).toBe(pod.namespace);
  const row = KINDS["apps/v1/deployments"]
    ?.rows(new Cluster("prod-eu", 5000, Date.now()), false)
    .find((candidate) => candidate.cells[0] === name);
  expect(
    batch.overview?.header.printed.map((cell) => cell.value),
    "the header prints what the list's row does",
  ).toEqual(
    [
      row?.cells[1],
      row?.cells[2],
      row?.cells[3],
      row?.cells[5],
      row?.cells[6],
      row?.cells[7],
    ].map(String),
  );
  const owned = await open(
    "ready",
    query({
      namespaces: [pod.namespace],
      owners: list.owners,
    }),
  );
  expect(owned.batches[0]?.total).toBe(
    pods.filter(
      (candidate) =>
        candidate.namespace === pod.namespace &&
        candidate.generateName === `${name}-${candidate.templateHash}-`,
    ).length,
  );
  expect(owned.batches[0]?.total).toBeGreaterThan(0);
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

test("a schema comes recorded for a few kinds and is not found for the others", async () => {
  const backend = createMockBackend();
  const schemaOf = async (group: string, version: string, kind: string) =>
    JSON.parse(
      await call(
        backend.invoke("schema_get", {
          space: "prod-eu",
          group,
          version,
          kind,
        }),
      ),
    ) as {
      $schema: string;
      properties: { apiVersion: { enum: string[] }; kind: { enum: string[] } };
      definitions: Record<string, unknown>;
    };

  for (const [group, version, kind, apiVersion] of [
    ["apps", "v1", "Deployment", "apps/v1"],
    ["", "v1", "Pod", "v1"],
    ["", "v1", "ConfigMap", "v1"],
    ["kwok.x-k8s.io", "v1alpha1", "Stage", "kwok.x-k8s.io/v1alpha1"],
  ] as const) {
    const schema = await schemaOf(group, version, kind);
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(schema.properties.apiVersion.enum).toEqual([apiVersion]);
    expect(schema.properties.kind.enum).toEqual([kind]);
    expect(
      schema.definitions["io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta"],
    ).toBeDefined();
  }

  for (const request of [
    { space: "prod-eu", group: "apps", version: "v1", kind: "Nothing" },
    { space: "nowhere", group: "apps", version: "v1", kind: "Deployment" },
  ]) {
    const failed = backend
      .invoke("schema_get", request)
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(await failed).toMatchObject({ kind: "notFound" });
  }
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

test("counts follow the rows once a live list syncs", async () => {
  const { batches, ack } = await open("live", query({ countBy: "Status" }));
  for (let i = 0; i < 40; i++) {
    await ack();
    await vi.advanceTimersByTimeAsync(50);
  }
  const counts = batches.flatMap((batch) =>
    batch.counts ? [batch.counts] : [],
  );
  const latest = counts[counts.length - 1] ?? [];
  expect(latest.reduce((sum, value) => sum + value.count, 0)).toBe(5000);
});

test("a change of counts alone sends a batch with the new counts", async () => {
  const { batches, ack } = await open("live", query({ countBy: "Status" }));
  for (let ms = 0; ms < 4000; ms += 50) {
    await ack();
    await vi.advanceTimersByTimeAsync(50);
  }
  const ready = batches.findIndex((batch) => batch.status.state === "ready");
  const after = batches.slice(ready + 1);
  expect(ready).toBeGreaterThan(0);
  expect(after.length).toBeGreaterThan(0);
  expect(after.every((batch) => batch.counts !== null)).toBe(true);
  after.forEach((batch, i) => {
    expect(batch.counts).not.toEqual(batches[ready + i]?.counts);
  });
});

test("no countBy, no counts", async () => {
  const { batches } = await open("ready");
  expect(batches.every((batch) => batch.counts === null)).toBe(true);
});

test("values keep their rows, and the counts stay those of every value", async () => {
  const all = await open("ready", query({ countBy: "Status" }));
  const picked = await open(
    "ready",
    query({
      countBy: "Status",
      values: { column: "Status", values: ["CrashLoopBackOff", "Error"] },
    }),
  );
  const counts = all.batches[0]?.counts ?? [];
  const count = (value: string) =>
    counts.find((counted) => counted.value === value)?.count ?? 0;
  expect(picked.batches[0]?.total).toBe(
    count("CrashLoopBackOff") + count("Error"),
  );
  expect(picked.batches[0]?.total).toBeGreaterThan(0);
  expect(picked.batches[0]?.counts).toEqual(counts);
});

test("values of a column the list lacks keep every row", async () => {
  const { batches } = await open(
    "ready",
    query({ values: { column: "Bogus", values: ["x"] } }),
  );
  expect(batches[0]?.total).toBe(5000);
});

test("a grouped list sends its groups, and its window skips the collapsed ones", async () => {
  const grouped = await open(
    "ready",
    query({ groupBy: { column: "Status", collapsed: [] } }),
  );
  const groups = grouped.batches[0]?.groups ?? [];
  expect(groups.map((group) => group.value)).toEqual(
    groups.map((group) => group.value).sort(natural),
  );
  expect(groups.reduce((sum, group) => sum + group.rows, 0)).toBe(5000);
  const running = groups.find((group) => group.value === "Running")?.rows;
  expect(running).toBeGreaterThan(0);

  const collapsed = await open(
    "ready",
    query({ groupBy: { column: "Status", collapsed: ["Running"] } }),
  );
  await collapsed.ack();
  await collapsed.window(0, 5000);
  await vi.advanceTimersByTimeAsync(10);
  const batch = last(collapsed.batches);
  expect(batch?.total).toBe(5000);
  expect(batch?.window?.ids).toHaveLength(5000 - (running ?? 0));
  expect(collapsed.batches[0]?.groups).toEqual(groups);
});

test("groups come once a list knows its columns, empty until it shows rows", async () => {
  for (const [scenario, groups] of [
    ["connecting", null],
    ["syncing", []],
  ] as const) {
    const sub = await open(
      scenario,
      query({ groupBy: { column: "Status", collapsed: [] } }),
    );
    expect(sub.batches[0]?.groups, scenario).toEqual(groups);
  }
  const odd = await open(
    "ready",
    query({ groupBy: { column: "Bogus", collapsed: [""] } }),
  );
  expect(odd.batches[0]?.groups).toBeNull();
  expect(odd.batches[0]?.total).toBe(5000);
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

function sectionOf(batch: ObjectBatch, id: string) {
  const found = batch.overview?.sections.find((section) => section.id === id);
  if (!found) throw new Error(`no ${id}`);
  return found;
}

function lastOf<T>(items: readonly T[]): T | undefined {
  return items[items.length - 1];
}

function near(moment: string | null | undefined, expected: number): boolean {
  return Math.abs(Date.parse(moment ?? "") - expected) < 100;
}

function said(spans: readonly { type: string; text?: string }[]): string {
  return spans.map((span) => span.text ?? "<ago>").join("");
}

test("a mock pod's Containers summary counts the cards it lists", async () => {
  const cluster = new Cluster("prod-eu", 5000, Date.now());
  const crashing = cluster.pods.filter(
    (pod) => pod.status === "CrashLoopBackOff" && pod.containers >= 2,
  );
  const pods = [
    ...crashing.slice(0, 6),
    ...cluster.pods
      .filter((pod) => pod.status === "Running" && pod.containers >= 2)
      .slice(0, 6),
  ];
  expect(pods.length).toBeGreaterThan(4);
  for (const pod of pods) {
    const batch = await described("pods", "", pod.namespace, pod.name);
    const containers = sectionOf(batch, "core.containers");
    const cards = containers.blocks.flatMap((block) =>
      block.type === "containers" ? block.containers : [],
    );
    const failing = cards.filter(
      (card) => card.state?.tone === "danger",
    ).length;
    expect(said(containers.summary), pod.name).toBe(
      `${String(cards.length)}${failing > 0 ? ` · ${String(failing)} failing` : ""}`,
    );
  }
  const two = crashing.find((pod) => pod.containers === 2);
  if (!two)
    throw new Error("prod-eu has a crash-looping pod of two containers");
  const batch = await described("pods", "", two.namespace, two.name);
  expect(said(sectionOf(batch, "core.containers").summary)).toBe(
    finishedInit(two) ? "3 · 1 failing" : "2 · 1 failing",
  );
});

test("a mock pod that completed says when, and every pod's page dates itself as its row does", async () => {
  const cluster = new Cluster("prod-eu", 5000, Date.now());
  const done = cluster.pods.find((pod) => pod.status === "Completed");
  if (!done) throw new Error("prod-eu has a completed pod");
  const batch = await described("pods", "", done.namespace, done.name);
  const sentence = batch.overview?.header.sentence ?? [];
  expect(sentence[0]).toEqual({ type: "text", text: "Finished " });
  expect(sentence[1]?.type).toBe("ago");
  expect(sentence).toHaveLength(2);
  for (const pod of [done, cluster.pods[0]]) {
    if (!pod) throw new Error("a pod");
    const page = await described("pods", "", pod.namespace, pod.name);
    const at = page.overview?.header.created;
    expect(near(at, pod.created)).toBe(true);
    const metadata = sectionOf(page, "core.metadata");
    const field = metadata.blocks
      .flatMap((block) => (block.type === "fields" ? block.fields : []))
      .find((candidate) => candidate.label === "Created");
    expect(field?.value).toEqual({ type: "time", at });
  }
});

function opened(
  cluster: Cluster,
  group: string,
  resource: string,
  namespace: string,
  name: string,
): Overview {
  const batches: ObjectBatch[] = [];
  new MockObject(
    {
      space: "prod-eu",
      gvr: { group, version: "v1", resource },
      namespaced: namespace !== "",
      namespace: namespace === "" ? null : namespace,
      name,
    },
    OVERVIEW,
    cluster,
    (batch) => batches.push(batch),
  );
  vi.advanceTimersByTime(1);
  const overview = batches[0]?.overview;
  if (!overview) throw new Error(`no ${name}`);
  return overview;
}

function section(overview: Overview, id: string): Section {
  const found = overview.sections.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no ${id}`);
  return found;
}

function fieldsOf(overview: Overview, id: string): Field[] {
  return section(overview, id).blocks.flatMap((block) =>
    block.type === "fields" ? block.fields : [],
  );
}

test("a mock Deployment's page says its own counts, ReplicaSets and image, and one below what its strategy keeps carries the Available finding", () => {
  const small = new Cluster("qa", POD_COUNT.qa ?? 0, Date.now());
  const large = new Cluster("prod-eu", POD_COUNT["prod-eu"] ?? 0, Date.now());
  const keeps = (replicas: number) => replicas - Math.floor(replicas / 4);
  const short = deployments(small).find(
    ({ ready, replicas }) => ready < keeps(replicas),
  );
  const slack = deployments(large).find(
    ({ ready, replicas }) => ready < replicas && ready >= keeps(replicas),
  );
  const whole = deployments(large).find(
    ({ replicas, ready }) => replicas > 0 && ready === replicas,
  );
  if (!short || !slack || !whole) throw new Error("the mock has all three");
  const clusterOf = (deployment: typeof short) =>
    deployment === short ? small : large;
  for (const deployment of [short, slack, whole]) {
    const cluster = clusterOf(deployment);
    const { namespace, name, replicas, ready, templateHash, image } =
      deployment;
    const page = opened(cluster, "apps", "deployments", namespace, name);
    const { header } = page;
    const counts = `${String(ready)}/${String(replicas)}`;
    expect(header.vitals[0]?.value).toMatchObject({ text: counts });
    const transitions = new Map(
      conditionsOf(page).map(({ type, lastTransition }) => [
        type,
        lastTransition,
      ]),
    );
    const made = new Date(deployment.created).toISOString();
    expect(transitions.get("Progressing"), name).toBe(made);
    if (deployment === short) {
      expect(transitions.get("Available"), name).not.toBe(made);
    } else {
      expect(transitions.get("Available"), name).toBe(made);
    }
    expect(near(header.created, deployment.created)).toBe(true);
    expect(
      header.printed.find(({ column }) => column === "Images")?.value,
    ).toBe(image);
    const rollout = section(page, "core.rollout");
    expect(rollout.tone, name).toBeNull();
    const rows = fieldsOf(page, "core.rollout");
    expect(rows.find(({ label }) => label === "Replicas")?.value).toEqual({
      type: "text",
      text: `${String(replicas)} desired | ${String(replicas)} updated | ${String(replicas)} total | ${String(ready)} available | ${String(replicas - ready)} unavailable`,
    });
    const set = `${name}-${templateHash}`;
    expect(rows.find(({ label }) => label === "New ReplicaSet")?.value).toEqual(
      {
        type: "link",
        target: {
          group: "apps",
          version: "v1",
          kind: "ReplicaSet",
          namespace,
          name: set,
        },
        text: `${set} (${String(replicas)}/${String(replicas)} replicas created)`,
      },
    );
    const [history, previous] = rollout.blocks.flatMap((block) =>
      block.type === "table" ? block.rows : [],
    );
    expect(history?.[1]).toMatchObject({ type: "link", target: { name: set } });
    expect(history?.[2]).toEqual({ type: "code", text: image });
    expect(history?.[3]).toEqual({ type: "text", text: counts });
    const [card] = section(page, "core.template").blocks.flatMap((block) =>
      block.type === "containers" ? block.containers : [],
    );
    expect([card?.name, card?.image]).toEqual([deployment.container, image]);
    expect(said(section(page, "core.template").summary)).toBe(
      image.split("/").pop(),
    );
    const progressing = section(page, "core.conditions").blocks.flatMap(
      (block) => (block.type === "conditions" ? block.conditions : []),
    );
    expect(
      progressing.find(({ type }) => type === "Progressing")?.message,
    ).toBe(`ReplicaSet "${set}" has successfully progressed.`);
    const update = fieldsOf(page, "core.strategy").find(
      ({ label }) => label === "Strategy",
    )?.value;
    expect(update?.type === "text" ? update.text : null).toContain(
      "25% max unavailable",
    );
    expect(said(section(page, "core.strategy").summary)).toBe(
      `RollingUpdate · ${String(replicas)} replica${replicas === 1 ? "" : "s"}`,
    );
    const age = lastOf(rollout.summary);
    expect(said(rollout.summary)).toContain("revision");
    expect(
      age?.type === "ago" && near(age.at, deployment.firstPod),
      "the revision's age is its first pod's, as its sentence says",
    ).toBe(true);
    expect(
      deployment.created,
      "a Deployment is older than its pods",
    ).toBeLessThan(deployment.firstPod);
    expect(
      history?.[4]?.type === "time" && near(history[4].at, deployment.firstPod),
      "its ReplicaSet began with its first pod",
    ).toBe(true);
    expect(
      previous?.[4]?.type === "time" &&
        near(previous[4].at, deployment.created),
      "the old ReplicaSet began with the Deployment",
    ).toBe(true);
    if (ready === replicas) expect(lastOf(header.sentence)).toEqual(age);
  }

  const title = "Fewer pods are available than it needs";
  const shortPage = opened(
    small,
    "apps",
    "deployments",
    short.namespace,
    short.name,
  );
  expect(shortPage.sections[0]?.id).toBe("core.diagnostics");
  expect(shortPage.header.sentence).toEqual([{ type: "text", text: title }]);
  const pods = section(shortPage, "core.pods");
  expect([said(pods.summary), pods.tone]).toEqual([title, "warning"]);
  const conditions = section(shortPage, "core.conditions");
  const [list] = conditions.blocks;
  if (list?.type !== "conditions") throw new Error("conditions");
  expect(
    list.conditions.map(({ type, status, explained }) => [
      type,
      status,
      explained,
    ]),
  ).toEqual([
    ["Available", "False", true],
    ["Progressing", "True", false],
  ]);
  expect([conditions.tone, conditions.fold, said(conditions.summary)]).toEqual([
    "warning",
    "folded",
    "1 of 2 ok",
  ]);
  const [diagnostics] = shortPage.sections[0]?.blocks ?? [];
  const since =
    diagnostics?.type === "diagnostics"
      ? diagnostics.findings[0]?.detail.find((span) => span.type === "ago")
      : undefined;
  const transition = list.conditions.find(
    ({ type }) => type === "Available",
  )?.lastTransition;
  expect(since?.type === "ago" && since.at).toBe(transition);

  const slackPage = opened(
    large,
    "apps",
    "deployments",
    slack.namespace,
    slack.name,
  );
  expect(slackPage.sections[0]?.id).toBe("core.rollout");
  const unready = section(slackPage, "core.pods");
  expect([said(unready.summary), unready.tone]).toEqual([
    `${String(slack.ready)}/${String(slack.replicas)} ready`,
    null,
  ]);
  expect(section(slackPage, "core.conditions").tone).toBeNull();

  const wholePage = opened(
    large,
    "apps",
    "deployments",
    whole.namespace,
    whole.name,
  );
  expect(wholePage.sections[0]?.id).toBe("core.rollout");
  expect(said(section(wholePage, "core.pods").summary)).toBe(
    `${String(whole.ready)}/${String(whole.replicas)} ready`,
  );
  expect(said(section(wholePage, "core.conditions").summary)).toBe("2 of 2 ok");
});

test("a mock Deployment carries the Available finding exactly where its pods fall below what its strategy keeps", () => {
  const cluster = new Cluster("kind-local", POD_COUNT["kind-local"] ?? 0, 0);
  let found = 0;
  for (const { namespace, name, ready, replicas } of deployments(cluster)) {
    const page = opened(cluster, "apps", "deployments", namespace, name);
    const finding = page.sections[0]?.id === "core.diagnostics";
    found += finding ? 1 : 0;
    expect(finding, `${name}: ${String(ready)} of ${String(replicas)}`).toBe(
      ready < replicas - Math.floor(replicas / 4),
    );
  }
  expect(found).toBeGreaterThan(0);
});

test("a mock pod's Placement says its own node and addresses, as its header and its row do", () => {
  const cluster = new Cluster("qa", POD_COUNT.qa ?? 0, Date.now());
  const states = [
    "Running",
    "CrashLoopBackOff",
    "Completed",
    "ContainerCreating",
  ];
  for (const status of states) {
    const pod = cluster.pods.find((candidate) => candidate.status === status);
    if (!pod) throw new Error(`qa has a ${status} pod`);
    const page = opened(cluster, "", "pods", pod.namespace, pod.name);
    const host = cluster.nodes.find(({ name }) => name === pod.node);
    expect(page.header.node, pod.name).toBe(pod.node);
    const rows = fieldsOf(page, "core.placement");
    const value = (label: string) => rows.find((row) => row.label === label);
    expect(value("Node")?.value).toMatchObject({
      type: "link",
      target: { kind: "Node", name: pod.node },
      text: pod.node,
    });
    expect(value("Pod IP")?.value).toEqual({ type: "code", text: pod.ip });
    expect(value("Host IP")?.value).toEqual({ type: "code", text: host?.ip });
    expect(said(section(page, "core.placement").summary)).toBe(
      `${pod.node} · ${pod.ip}`,
    );
    const cells = Object.fromEntries(
      page.header.printed.map(({ column, value: cell }) => [column, cell]),
    );
    expect([cells.Node, cells.IP]).toEqual([pod.node, pod.ip]);
    expect(JSON.stringify(page)).not.toContain("control-plane");
  }

  const orphan = cluster.pods.find((pod) => pod.status === "Running");
  if (!orphan) throw new Error("qa has a running pod");
  cluster.deleteNode(orphan.node);
  const page = opened(cluster, "", "pods", orphan.namespace, orphan.name);
  expect(
    fieldsOf(page, "core.placement").map(({ label }) => label),
    "its node is gone, so its address is unknown",
  ).not.toContain("Host IP");
});

test("a completed mock pod shows its containers terminated and its readiness as a state", () => {
  const cluster = new Cluster("prod-eu", 5000, Date.now());
  const pods = cluster.pods
    .filter((pod) => pod.status === "Completed")
    .slice(0, 6);
  expect(pods.length).toBeGreaterThan(2);
  for (const pod of pods) {
    const page = opened(cluster, "", "pods", pod.namespace, pod.name);
    const containers = section(page, "core.containers");
    const cards = containers.blocks.flatMap((block) =>
      block.type === "containers" ? block.containers : [],
    );
    expect(cards.length).toBeGreaterThanOrEqual(pod.containers);
    for (const [index, card] of cards.entries()) {
      expect(card.state, card.name).toEqual({
        text: "Terminated · Completed",
        tone: "neutral",
        ready: false,
        running: false,
        restarts: index === 0 ? Number.parseInt(pod.restarts, 10) : 0,
      });
      const exit = card.fields.find(({ label }) => label === "Exit code");
      expect(exit?.value).toEqual({ type: "text", text: "exit code 0" });
      const ended = card.fields.find(({ label }) => label === "Finished");
      expect(ended?.value).toEqual({
        type: "time",
        at: new Date(finishedAt(pod)).toISOString(),
      });
    }
    expect([containers.tone, said(containers.summary)]).toEqual([
      null,
      String(cards.length),
    ]);
    const conditions = section(page, "core.conditions");
    const [list] = conditions.blocks;
    if (list?.type !== "conditions") throw new Error("conditions");
    expect(
      list.conditions.map(({ type, status, tone, reason, explained }) => [
        type,
        status,
        tone,
        reason,
        explained,
      ]),
    ).toEqual([
      ["PodReadyToStartContainers", "False", "neutral", "PodCompleted", false],
      ["Initialized", "True", "neutral", "PodCompleted", false],
      ["Ready", "False", "neutral", "PodCompleted", false],
      ["ContainersReady", "False", "neutral", "PodCompleted", false],
      ["PodScheduled", "True", "success", null, false],
    ]);
    expect([
      conditions.tone,
      conditions.fold,
      said(conditions.summary),
    ]).toEqual([null, "folded", "1 of 1 ok"]);
    const stamped = new Map(
      list.conditions.map(({ type, lastTransition }) => [type, lastTransition]),
    );
    const finished = new Date(finishedAt(pod)).toISOString();
    expect([
      stamped.get("Initialized"),
      ...["PodReadyToStartContainers", "Ready", "ContainersReady"].map((type) =>
        stamped.get(type),
      ),
    ]).toEqual([
      new Date(pod.created + 2000).toISOString(),
      finished,
      finished,
      finished,
    ]);
    expect(page.header.vitals[0]?.value).toMatchObject({
      type: "text",
      text: `0/${String(pod.containers)}`,
    });
  }
});

test("a mock pod's Restarts are toned only for a container that crashes or failed", () => {
  const cluster = new Cluster("prod-eu", 5000, Date.now());
  const restarted = (status: string) => {
    const pod = cluster.pods.find(
      (candidate) =>
        candidate.status === status && candidate.restarts.startsWith("1 "),
    );
    if (!pod) throw new Error(`prod-eu has a ${status} pod that restarted`);
    return pod;
  };
  const crashing = cluster.pods.find(
    (pod) => pod.status === "CrashLoopBackOff",
  );
  const running = restarted("Running");
  if (!crashing) throw new Error("prod-eu has a crash loop");
  running.ready = 0;
  for (const [pod, tone] of [
    [crashing, "toned"],
    [running, "text"],
  ] as const) {
    const page = opened(cluster, "", "pods", pod.namespace, pod.name);
    const restarts = page.header.vitals.find(
      ({ label }) => label === "Restarts",
    );
    expect(restarts?.value.type, pod.status).toBe(tone);
  }
});

test("a mock Job and CronJob say when they were made and what their rows print", () => {
  const cluster = new Cluster("prod-eu", 5000, Date.now());
  const cells = (kind: string, id: string) =>
    KINDS[kind]?.rows(cluster, false).find((row) => row.id === id)?.cells ?? [];
  const printedAs = (page: Overview) =>
    new Map(page.header.printed.map(({ column, value }) => [column, value]));
  const createdIn = (page: Overview) =>
    fieldsOf(page, "core.metadata").find(({ label }) => label === "Created")
      ?.value;

  for (const job of cluster.jobs.slice(0, 3)) {
    const page = opened(cluster, "batch", "jobs", job.namespace, job.name);
    const row = cells("batch/v1/jobs", job.id);
    const shown = printedAs(page);
    expect([
      shown.get("Status"),
      shown.get("Completions"),
      shown.get("Duration"),
    ]).toEqual([row[1], row[2], row[3] === "" ? undefined : row[3]]);
    expect(near(page.header.created, job.created)).toBe(true);
    expect(createdIn(page)).toEqual({ type: "time", at: page.header.created });
  }
  for (const cronJob of cluster.cronJobs.slice(0, 3)) {
    const page = opened(
      cluster,
      "batch",
      "cronjobs",
      cronJob.namespace,
      cronJob.name,
    );
    const row = cells("batch/v1/cronjobs", cronJob.id);
    const shown = printedAs(page);
    expect([
      shown.get("Schedule"),
      shown.get("Suspend"),
      shown.get("Active"),
      shown.get("Last Schedule"),
    ]).toEqual([row[1], row[3], String(row[4]), row[5]]);
    expect(near(page.header.created, cronJob.created)).toBe(true);
    expect(createdIn(page)).toEqual({ type: "time", at: page.header.created });
  }
});

function cardsOf(page: Overview) {
  return section(page, "core.containers").blocks.flatMap((block) =>
    block.type === "containers" ? block.containers : [],
  );
}

function conditionsOf(page: Overview) {
  return section(page, "core.conditions").blocks.flatMap((block) =>
    block.type === "conditions" ? block.conditions : [],
  );
}

function eventsOf(page: Overview) {
  return section(page, "core.events").blocks.flatMap((block) =>
    block.type === "events" ? block.events : [],
  );
}

function findingsOf(page: Overview) {
  return page.sections
    .filter(({ id }) => id === "core.diagnostics")
    .flatMap(({ blocks }) => blocks)
    .flatMap((block) => (block.type === "diagnostics" ? block.findings : []));
}

function timeOf(fields: readonly Field[], label: string): string | undefined {
  const value = fields.find((field) => field.label === label)?.value;
  return value?.type === "time" ? value.at : undefined;
}

test("a mock pod's first container, image and events are its Deployment's and its own", () => {
  const cluster = new Cluster("qa", POD_COUNT.qa ?? 0, Date.now());
  for (const status of [
    "Running",
    "CrashLoopBackOff",
    "ImagePullBackOff",
    "ContainerCreating",
  ]) {
    const pod = cluster.pods.find(
      (candidate) =>
        candidate.status === status &&
        (status !== "Running" || candidate.containers >= 2),
    );
    if (!pod) throw new Error(`qa has a ${status} pod`);
    const page = opened(cluster, "", "pods", pod.namespace, pod.name);
    const [card, second] = cardsOf(page).filter(({ role }) => role !== "init");
    const container = containerOf(pod);
    expect([card?.name, card?.image], status).toEqual([
      container,
      imageOf(pod),
    ]);
    if (status === "Running") {
      expect([second?.name, second?.image]).toEqual([
        "istio-proxy",
        imageOf(pod, "istio-proxy"),
      ]);
    }
    const messages = eventsOf(page).map(({ message }) => message);
    expect(messages.join("\n"), status).not.toContain("overview");
    expect(
      messages.find((message) => message.startsWith("Successfully assigned")),
      status,
    ).toBe(`Successfully assigned ${pod.namespace}/${pod.name} to ${pod.node}`);
    for (const message of messages.filter((one) => one.includes("image "))) {
      expect(message, status).toContain(imageOf(pod));
    }
    expect(fieldText(page, "UID"), status).toBe(uid(pod.id));
    for (const { title, logs } of findingsOf(page)) {
      expect(title, status).toContain(container);
      if (logs) expect(logs.container, status).toBe(container);
    }
  }
  const crashing = cluster.pods.find(
    (candidate) => candidate.status === "CrashLoopBackOff",
  );
  if (!crashing) throw new Error("qa has a crash loop");
  const page = opened(cluster, "", "pods", crashing.namespace, crashing.name);
  expect(
    eventsOf(page).find(({ reason }) => reason === "BackOff")?.message,
  ).toBe(
    `Back-off restarting failed container ${containerOf(crashing)} in pod ${crashing.name}_${crashing.namespace}(${uid(crashing.id)})`,
  );
});

test("a mock pod's restarts are the same in its header, its first container and its finding", () => {
  const cluster = new Cluster("prod-eu", 5000, Date.now());
  for (const status of ["Running", "CrashLoopBackOff", "Error", "Completed"]) {
    const pod = cluster.pods.find(
      (candidate) =>
        candidate.status === status &&
        candidate.lastRestart !== null &&
        (status !== "Running" || candidate.ready === candidate.containers),
    );
    if (!pod) throw new Error(`prod-eu has a ${status} pod that restarted`);
    const last = pod.lastRestart ?? 0;
    const count = Number.parseInt(pod.restarts, 10);
    const at = new Date(last).toISOString();
    const page = opened(cluster, "", "pods", pod.namespace, pod.name);
    const restarts = page.header.vitals.find(
      ({ label }) => label === "Restarts",
    );
    expect(restarts?.value, status).toMatchObject({ text: String(count) });
    expect(restarts?.note, status).toEqual([{ type: "ago", at }]);
    const [card] = cardsOf(page).filter(({ role }) => role !== "init");
    expect(card?.state?.restarts, status).toBe(count);
    expect(timeOf(card?.fields ?? [], "Last finished"), status).toBe(at);
    expect(
      card?.fields.find(({ label }) => label === "Last state")?.value,
      status,
    ).toEqual({ type: "text", text: "Terminated · Error · exit code 1" });
    if (status === "Running" || status === "Completed" || status === "Error") {
      expect(timeOf(card?.fields ?? [], "Started"), status).toBe(at);
    }
    if (status === "Completed") {
      expect(Date.parse(at), "it restarted before it finished").toBeLessThan(
        Date.parse(timeOf(card?.fields ?? [], "Finished") ?? ""),
      );
    }
    if (status === "CrashLoopBackOff") {
      const [finding] = findingsOf(page);
      const [shown, next] = ["ago", "until"].map((type) =>
        finding?.detail.find((span) => span.type === type),
      );
      expect(said(finding?.detail ?? []), status).toBe(
        `Exited with code 1, ${String(count)} restarts, last <ago>. Next start <ago>.`,
      );
      expect(shown, status).toEqual({ type: "ago", at });
      expect(next?.type === "until" && Date.parse(next.at)).toBe(
        last + Math.min(300, 10 * 2 ** (count - 1)) * 1000,
      );
    }
  }
  for (const status of ["Pending", "ContainerCreating"]) {
    const pod = cluster.pods.find((candidate) => candidate.status === status);
    if (!pod) throw new Error(`prod-eu has a ${status} pod`);
    const page = opened(cluster, "", "pods", pod.namespace, pod.name);
    const restarts = page.header.vitals.find(
      ({ label }) => label === "Restarts",
    );
    expect([restarts?.value, restarts?.note], status).toEqual([
      { type: "text", text: "0" },
      [],
    ]);
    expect(
      cardsOf(page).map(({ state }) => state?.restarts ?? 0),
      status,
    ).toEqual(cardsOf(page).map(() => 0));
  }
});

test("a ContainerCreating mock pod waits in every container, and an Error one has terminated in its first", () => {
  const cluster = new Cluster("prod-eu", 5000, Date.now());
  const creating = cluster.pods.find(
    (candidate) =>
      candidate.status === "ContainerCreating" && candidate.containers >= 2,
  );
  const errored = cluster.pods.find(
    (candidate) => candidate.status === "Error" && candidate.containers >= 2,
  );
  if (!creating || !errored) throw new Error("prod-eu has both");

  const page = opened(cluster, "", "pods", creating.namespace, creating.name);
  const cards = cardsOf(page);
  expect(cards).toHaveLength(creating.containers);
  for (const card of cards) {
    expect(card.state, card.name).toEqual({
      text: "Waiting · ContainerCreating",
      tone: "neutral",
      ready: false,
      running: false,
      restarts: 0,
    });
  }
  const conditions = conditionsOf(page);
  expect(
    conditions.map(({ type, status, tone, explained }) => [
      type,
      status,
      tone,
      explained,
    ]),
  ).toEqual([
    ["PodReadyToStartContainers", "True", "success", false],
    ["Initialized", "True", "success", false],
    ["Ready", "False", "warning", false],
    ["ContainersReady", "False", "warning", false],
    ["PodScheduled", "True", "success", false],
  ]);
  const unready = section(page, "core.conditions");
  expect([unready.tone, unready.fold, said(unready.summary)]).toEqual([
    "warning",
    "folded",
    "3 of 5 ok",
  ]);
  expect(section(page, "core.containers").tone).toBeNull();
  expect(findingsOf(page)).toEqual([]);

  const failed = opened(cluster, "", "pods", errored.namespace, errored.name);
  const container = containerOf(errored);
  const [first, ...others] = cardsOf(failed);
  expect(first?.state).toMatchObject({
    text: "Terminated · Error",
    tone: "danger",
    ready: false,
    running: false,
  });
  expect(
    first?.fields.find(({ label }) => label === "Exit code")?.value,
  ).toEqual({ type: "text", text: "exit code 1" });
  for (const other of others) expect(other.state?.ready, other.name).toBe(true);
  const regular = cardsOf(failed).filter(({ role }) => role !== "init");
  expect(
    failed.header.vitals.find(({ label }) => label === "Ready")?.value,
  ).toMatchObject({
    text: `${String(regular.filter(({ state }) => state?.ready).length)}/${String(regular.length)}`,
  });
  const [finding] = findingsOf(failed);
  expect(finding?.title).toBe(`Container ${container} failed`);
  expect(finding?.logs?.container).toBe(container);
  expect(said(finding?.detail ?? [])).toBe("Exited with code 1 <ago>.");
  expect(failed.header.sentence).toEqual([
    { type: "text", text: `Container ${container} failed` },
  ]);
  const containers = section(failed, "core.containers");
  expect([containers.tone, said(containers.summary)]).toEqual([
    "danger",
    `${String(errored.containers)} · 1 failing`,
  ]);
});

test("a ContainerCreating mock pod's events say it was scheduled and pulls its image, and an Error pod that never restarted has no BackOff", () => {
  const cluster = new Cluster("prod-eu", 5000, Date.now());
  const creating = cluster.pods.find(
    (candidate) => candidate.status === "ContainerCreating",
  );
  const errored = cluster.pods.filter(
    (candidate) => candidate.status === "Error",
  );
  const never = errored.find((candidate) => candidate.lastRestart === null);
  const again = errored.find((candidate) => candidate.lastRestart !== null);
  if (!creating || !never || !again) throw new Error("prod-eu has all three");
  const reasons = (pod: Pod) =>
    eventsOf(opened(cluster, "", "pods", pod.namespace, pod.name)).map(
      ({ reason }) => reason,
    );

  const page = opened(cluster, "", "pods", creating.namespace, creating.name);
  expect(reasons(creating)).toEqual(["Pulling", "Scheduled"]);
  expect(eventsOf(page)[0]).toMatchObject({
    message: `Pulling image "${imageOf(creating)}"`,
    fieldPath: `spec.containers{${containerOf(creating)}}`,
  });
  const events = section(page, "core.events");
  expect([events.tone, events.fold, said(events.summary)]).toEqual([
    null,
    "folded",
    "2 events · <ago>",
  ]);

  expect(reasons(never)).toEqual(["Created", "Started", "Pulled", "Scheduled"]);
  const quiet = section(
    opened(cluster, "", "pods", never.namespace, never.name),
    "core.events",
  );
  expect([quiet.tone, quiet.fold, said(quiet.summary)]).toEqual([
    null,
    "folded",
    "4 events · <ago>",
  ]);
  expect(reasons(again)).toContain("BackOff");
});

test("a mock pod's Ready is what its row prints and what its ready cards count, in every state", () => {
  const cluster = new Cluster("prod-eu", 5000, Date.now());
  const rows = new Map(
    KINDS["/v1/pods"]?.rows(cluster, false).map((row) => [row.id, row]),
  );
  for (const status of [
    "Running",
    "CrashLoopBackOff",
    "Error",
    "ImagePullBackOff",
    "ContainerCreating",
    "Pending",
    "Completed",
  ]) {
    const pod = cluster.pods.find(
      (candidate) => candidate.status === status && candidate.containers >= 2,
    );
    if (!pod) throw new Error(`prod-eu has a ${status} pod with sidecars`);
    const page = opened(cluster, "", "pods", pod.namespace, pod.name);
    const cards = cardsOf(page).filter(({ role }) => role !== "init");
    const counted = `${String(cards.filter(({ state }) => state?.ready).length)}/${String(cards.length)}`;
    const shown = page.header.vitals.find(({ label }) => label === "Ready");
    expect(shown?.value, status).toMatchObject({ text: counted });
    expect(rows.get(pod.id)?.cells[1], status).toBe(counted);
  }
});

test("a crash loop's next start comes a back-off after its last exit: 10 s doubled at each restart, to 5 minutes", () => {
  const cluster = new Cluster("prod-eu", 5000, Date.now());
  const pod = cluster.pods.find(
    (candidate) => candidate.status === "CrashLoopBackOff",
  );
  const last = pod?.lastRestart;
  if (!pod || last === null || last === undefined)
    throw new Error("prod-eu has a crash loop that restarted");
  const next = (restarts: number) => {
    pod.restarts = `${String(restarts)} (30s ago)`;
    const page = opened(cluster, "", "pods", pod.namespace, pod.name);
    const [finding] = findingsOf(page);
    const until = finding?.detail.find((span) => span.type === "until");
    return until?.type === "until" ? (Date.parse(until.at) - last) / 1000 : NaN;
  };
  expect([1, 2, 3, 4, 5, 6, 7, 44].map((restarts) => next(restarts))).toEqual([
    10, 20, 40, 80, 160, 300, 300, 300,
  ]);
});

test("a mock Deployment's header prints what its row does, even where its container is named web", () => {
  const cluster = new Cluster("prod-eu", 5000, Date.now());
  const web = deployments(cluster).find(({ name }) => name.endsWith("-web"));
  if (!web) throw new Error("prod-eu has a Deployment of a web workload");
  const page = opened(cluster, "apps", "deployments", web.namespace, web.name);
  const row = KINDS["apps/v1/deployments"]
    ?.rows(cluster, false)
    .find((candidate) => candidate.cells[0] === web.name);
  const shown = new Map(
    page.header.printed.map(({ column, value }) => [column, value]),
  );
  expect([
    shown.get("Ready"),
    shown.get("Containers"),
    shown.get("Images"),
    shown.get("Selector"),
  ]).toEqual([row?.cells[1], row?.cells[5], row?.cells[6], row?.cells[7]]);
  expect(shown.get("Containers")).toBe("web");
});

test("a mock Job says its own state and moments, selector and template, and its CronJob its schedule and jobs", () => {
  const cluster = new Cluster("prod-eu", 5000, Date.now());
  const [done] = cluster.jobs;
  const cron = cluster.cronJobs.find(
    (candidate) => candidate.name === done?.owner,
  );
  if (!done || !cron) throw new Error("prod-eu has a Job of a CronJob");
  cluster.trigger(cron.namespace, cron.name, `${cron.name}-manual`, Date.now());
  const running = cluster.jobs.find(
    ({ name }) => name === `${cron.name}-manual`,
  );
  const other = cluster.cronJobs.find(({ name }) => name !== cron.name);
  if (!running || !other) throw new Error("prod-eu has more CronJobs");
  cluster.trigger(
    other.namespace,
    other.name,
    `${other.name}-paused`,
    Date.now(),
  );
  const paused = cluster.jobs.find(
    ({ name }) => name === `${other.name}-paused`,
  );
  if (!paused) throw new Error("a triggered Job");
  cluster.suspend(paused, true, Date.now());
  const row = (job: (typeof cluster.jobs)[number]) =>
    KINDS["batch/v1/jobs"]?.rows(cluster, false).find(({ id }) => id === job.id)
      ?.cells ?? [];

  for (const [job, state] of [
    [done, "complete"],
    [running, "running"],
    [paused, "suspended"],
  ] as const) {
    const page = opened(cluster, "batch", "jobs", job.namespace, job.name);
    const own = fieldsOf(page, "core.job");
    const value = (label: string) => own.find((field) => field.label === label);
    const cells = row(job);
    expect(value("Selector")?.value, state).toEqual({
      type: "code",
      text: String(cells[7]),
    });
    expect([timeOf(own, "Started"), timeOf(own, "Completed")], state).toEqual([
      job.started === null ? undefined : new Date(job.started).toISOString(),
      job.completed === null
        ? undefined
        : new Date(job.completed).toISOString(),
    ]);
    const seconds = Math.floor(
      ((job.completed ?? 0) - (job.started ?? 0)) / 1000,
    );
    expect(value("Duration")?.value ?? null, state).toEqual(
      job.completed === null
        ? null
        : {
            type: "text",
            text:
              seconds < 60
                ? `${String(seconds)}s`
                : `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`,
          },
    );
    expect(value("Pods")?.value, state).toEqual({
      type: "text",
      text: {
        complete: "0 active (0 ready) | 1 succeeded | 0 failed",
        running: "1 active (1 ready) | 0 succeeded | 0 failed",
        suspended: "0 active (0 ready) | 0 succeeded | 0 failed",
      }[state],
    });
    expect(
      [
        said(section(page, "core.job").summary),
        said(section(page, "core.pods").summary),
      ],
      state,
    ).toEqual(
      {
        complete: ["complete <ago>", "1 succeeded"],
        running: ["0/1 completions", "1 active"],
        suspended: ["0/1 completions", ""],
      }[state],
    );
    const conditions = page.sections.some(({ id }) => id === "core.conditions")
      ? conditionsOf(page).map(({ type, status, tone }) => [type, status, tone])
      : [];
    expect(conditions, state).toEqual(
      {
        complete: [
          ["SuccessCriteriaMet", "True", "success"],
          ["Complete", "True", "success"],
        ],
        running: [],
        suspended: [["Suspended", "True", "neutral"]],
      }[state],
    );
    const labels = section(page, "core.metadata").blocks.flatMap((block) =>
      block.type === "fields" ? block.fields : [],
    );
    expect(
      labels.find(({ label }) => label === "Labels")?.value,
      state,
    ).toMatchObject({
      type: "labels",
      labels: expect.arrayContaining([
        { key: "job-name", value: job.name },
        { key: "controller-uid", value: job.id },
      ]) as unknown,
    });
    const [card] = section(page, "core.template").blocks.flatMap((block) =>
      block.type === "containers" ? block.containers : [],
    );
    expect([card?.name, card?.image], state).toEqual([cells[5], cells[6]]);
    const reasons = eventsOf(page).map(({ reason }) => reason);
    expect(reasons, state).toEqual(
      {
        complete: ["Completed", "SuccessfulCreate"],
        running: ["SuccessfulCreate"],
        suspended: ["Suspended", "SuccessfulDelete", "SuccessfulCreate"],
      }[state],
    );
  }

  const next = {
    ...done,
    id: `${done.id}-next`,
    name: `${done.name}-next`,
    completed: null,
    created: done.created + 60_000,
    started: done.created + 60_000,
  };
  cluster.jobs.push(next);
  const first = opened(cluster, "batch", "cronjobs", cron.namespace, cron.name);
  const own = fieldsOf(first, "core.cronjob");
  const value = (label: string) => own.find((field) => field.label === label);
  expect(value("Schedule")?.value).toEqual({
    type: "code",
    text: cron.schedule,
  });
  expect(value("Suspend")?.value).toEqual({ type: "text", text: "false" });
  expect(timeOf(own, "Last schedule")).toBe(
    new Date(cron.lastSchedule).toISOString(),
  );
  expect(timeOf(own, "Last success")).toBe(
    new Date(done.completed ?? 0).toISOString(),
  );
  expect(value("Active jobs")?.value).toMatchObject({
    type: "list",
    items: [{ type: "link", target: { kind: "Job", name: next.name } }],
  });
  expect(
    KINDS["batch/v1/cronjobs"]
      ?.rows(cluster, false)
      .find(({ id }) => id === cron.id)?.cells[4],
  ).toBe(1);
  expect(said(section(first, "core.cronjob").summary)).toBe(
    `${cron.schedule} · last run <ago>`,
  );
  expect(said(section(first, "core.jobs").summary)).toBe("1 active");
  const names = eventsOf(first).map(({ message }) => message);
  expect(names).toContain(`Created job ${done.name}`);
  expect(names).toContain(
    `Saw completed job: ${done.name}, condition: Complete`,
  );
  expect(names).toContain(`Created job ${next.name}`);
  expect(names).not.toContain(`Created job ${running.name}`);
  expect(names.join("\n")).not.toContain("report-");

  cluster.suspend(other, true, Date.now());
  const stopped = fieldsOf(
    opened(cluster, "batch", "cronjobs", other.namespace, other.name),
    "core.cronjob",
  );
  expect(stopped.find(({ label }) => label === "Suspend")?.value).toEqual({
    type: "toned",
    text: "true",
    tone: "warning",
  });
});

test("a mock CronJob counts and lists the Jobs its schedule made, and says it saw one it did not make", () => {
  const cluster = new Cluster("prod-eu", 5000, Date.now());
  const [done] = cluster.jobs;
  const cron = cluster.cronJobs.find(({ name }) => name === done?.owner);
  if (!done || !cron) throw new Error("prod-eu has a Job of a CronJob");
  const manual = `${cron.name}-manual`;
  cluster.trigger(cron.namespace, cron.name, manual, Date.now());
  const page = opened(cluster, "batch", "cronjobs", cron.namespace, cron.name);

  const active = fieldsOf(page, "core.cronjob").find(
    ({ label }) => label === "Active jobs",
  );
  expect(active?.value).toEqual({ type: "text", text: "none" });
  expect(said(section(page, "core.jobs").summary)).toBe("");
  expect(
    KINDS["batch/v1/cronjobs"]
      ?.rows(cluster, false)
      .find(({ id }) => id === cron.id)?.cells[4],
  ).toBe(0);

  const events = eventsOf(page);
  expect(
    events.filter(({ message }) => message.includes(manual)),
  ).toMatchObject([
    {
      type: "Warning",
      reason: "UnexpectedJob",
      message: `Saw a job that the controller did not create or forgot: ${manual}`,
      source: "cronjob-controller",
    },
  ]);
  const shown = section(page, "core.events");
  expect([shown.tone, shown.fold, said(shown.summary)]).toEqual([
    "warning",
    "open",
    "1 warning · UnexpectedJob",
  ]);
});

test("a mock Job suspended after it ran says when, and a resumed one keeps its Suspended condition False", () => {
  const cluster = new Cluster("prod-eu", 5000, Date.now());
  const [cron] = cluster.cronJobs;
  if (!cron) throw new Error("prod-eu has a CronJob");
  const made = Date.now();
  cluster.trigger(cron.namespace, cron.name, "run", made);
  const job = cluster.jobs.find(({ name }) => name === "run");
  if (!job) throw new Error("a triggered Job");
  const stopped = made + 60_000;
  const resumed = made + 120_000;
  const at = (moment: number) => new Date(moment).toISOString();
  const history = (page: Overview) =>
    eventsOf(page).map(({ reason, message, last }) => [reason, message, last]);

  cluster.suspend(job, true, stopped);
  const suspended = opened(cluster, "batch", "jobs", job.namespace, job.name);
  expect(
    conditionsOf(suspended).map(({ status, reason, lastTransition }) => [
      status,
      reason,
      lastTransition,
    ]),
  ).toEqual([["True", "JobSuspended", at(stopped)]]);
  const [first] = history(suspended).slice(-1);
  const pod = String(first?.[1]).replace("Created pod: ", "");
  expect(history(suspended)).toEqual([
    ["Suspended", "Job suspended", at(stopped)],
    ["SuccessfulDelete", `Deleted pod: ${pod}`, at(stopped)],
    ["SuccessfulCreate", `Created pod: ${pod}`, at(made)],
  ]);

  cluster.suspend(job, false, resumed);
  const running = opened(cluster, "batch", "jobs", job.namespace, job.name);
  expect(
    conditionsOf(running).map(({ status, reason, lastTransition }) => [
      status,
      reason,
      lastTransition,
    ]),
  ).toEqual([["False", "JobResumed", at(resumed)]]);
  expect(history(running).map(([reason]) => reason)).toEqual([
    "Resumed",
    "SuccessfulCreate",
    "Suspended",
    "SuccessfulDelete",
    "SuccessfulCreate",
  ]);
  expect(history(running)[0]).toEqual(["Resumed", "Job resumed", at(resumed)]);
  expect(history(running)[1]?.[1]).not.toBe(`Created pod: ${pod}`);
});

test("a mock node's body says what its header does, and a NotReady or cordoned one carries its finding", async () => {
  const cluster = new Cluster("prod-eu", 5000, Date.now());
  const find = (status: string) =>
    cluster.nodes.find((n) => n.status === status);
  const ready = find("Ready");
  const down = find("NotReady");
  const cordoned = find("Ready,SchedulingDisabled");
  if (!ready || !down || !cordoned) throw new Error("prod-eu has all three");
  for (const node of [ready, down, cordoned]) {
    const batch = await described("nodes", "", "", node.name);
    const header = batch.overview?.header;
    const pods = header?.vitals.find((vital) => vital.label === "Pods");
    const running = pods?.value.type === "text" ? pods.value.text : "";
    expect(said(sectionOf(batch, "core.pods").summary), node.name).toBe(
      `${running} pods`,
    );
    const kubelet = header?.vitals.find((vital) => vital.label === "Kubelet");
    const version = kubelet?.value.type === "text" ? kubelet.value.text : "";
    expect(version).not.toBe("");
    const rows = sectionOf(batch, "core.system").blocks.flatMap((block) =>
      block.type === "fields" ? block.fields : [],
    );
    expect(rows.find((field) => field.label === "Kubelet")?.value).toEqual({
      type: "text",
      text: version,
    });
    expect(said(sectionOf(batch, "core.system").summary)).toBe(
      `kubelet ${version}`,
    );
    expect(near(header?.created, node.created)).toBe(true);
  }

  const unreachable = await described("nodes", "", "", down.name);
  const first = unreachable.overview?.sections[0];
  expect(first?.id).toBe("core.diagnostics");
  const [diagnostics] = first?.blocks ?? [];
  if (diagnostics?.type !== "diagnostics") throw new Error("diagnostics");
  expect(diagnostics.findings.map(({ title }) => title)).toEqual([
    "The node is not ready",
  ]);
  expect(said(unreachable.overview?.header.sentence ?? [])).toBe(
    "The node is not ready",
  );
  const conditions = sectionOf(unreachable, "core.conditions");
  expect([conditions.tone, conditions.fold, said(conditions.summary)]).toEqual([
    "warning",
    "folded",
    "3 of 4 ok",
  ]);

  const held = await described("nodes", "", "", cordoned.name);
  expect(held.overview?.sections[0]?.id).toBe("core.diagnostics");
  expect(said(held.overview?.header.sentence ?? [])).toBe(
    "The node is cordoned",
  );
  const taints = sectionOf(held, "core.taints");
  expect([taints.tone, said(taints.summary)]).toEqual([
    "warning",
    "The node is cordoned",
  ]);
  const marks = taints.blocks.flatMap((block) =>
    block.type === "fields" ? block.fields : [],
  );
  expect(marks.find((field) => field.label === "Unschedulable")?.value).toEqual(
    { type: "toned", text: "true", tone: "warning" },
  );

  const healthy = await described("nodes", "", "", ready.name);
  expect(healthy.overview?.sections[0]?.id).not.toBe("core.diagnostics");
});
