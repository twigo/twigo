import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  Context,
  KeyboardLayout,
  ListBatch,
  ListQuery,
  ObjectBatch,
  ObjectParts,
} from "../generated";
import { Cluster, deploymentOf } from "./cluster";
import { createMockBackend, type MockScenario } from "./index";
import { KINDS } from "./kinds";
import { MockObject } from "./objects";
import { natural } from "./query";

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
  expect(healthy.overview?.sections[0]?.id).toBe("core.pod");
  const completed = pods.find((pod) => pod.status === "Completed");
  if (!completed) throw new Error("prod-eu has a completed pod");
  const done = await described("pods", "", completed.namespace, completed.name);
  expect(done.overview?.sections[0]?.id).toBe("core.pod");
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
