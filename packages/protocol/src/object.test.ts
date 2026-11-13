import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Backend } from "./backend";
import type {
  ObjectBatch,
  ObjectParts,
  ObjectQuery,
  Overview,
  Usage,
} from "./generated";
import { createMockBackend } from "./mock";
import { ObjectView } from "./object";

const POD: ObjectQuery = {
  space: "s",
  gvr: { group: "", version: "v1", resource: "pods" },
  namespaced: true,
  namespace: "payments",
  name: "api-0",
};

const OVERVIEW: ObjectParts = {
  overview: true,
  manifest: false,
  events: false,
  related: false,
  usage: false,
};

const DOCUMENT: Overview = {
  sections: [{ id: "core.metadata", title: "Metadata", blocks: [] }],
};

function batch(seq: number, rest: Partial<ObjectBatch> = {}): ObjectBatch {
  return {
    seq,
    status: { state: "ready" },
    exists: true,
    overview: null,
    manifest: null,
    events: null,
    related: null,
    usage: null,
    ...rest,
  };
}

function fakeBackend() {
  let send: ((batch: ObjectBatch) => void) | undefined;
  let resolve: ((id: number) => void) | undefined;
  const calls: [string, unknown][] = [];
  const backend: Backend = {
    invoke(command, request) {
      calls.push([command, request]);
      return Promise.resolve(null);
    },
    subscribe(_command, request, onMessage) {
      calls.push(["object_open", request]);
      send = onMessage;
      return new Promise((res) => {
        resolve = res;
      });
    },
  };
  return {
    backend,
    calls,
    send: (b: ObjectBatch) => send?.(b),
    resolve: (id: number) => resolve?.(id),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("a batch keeps the parts it does not carry and is acked on the next frame", async () => {
  const fake = fakeBackend();
  const view = new ObjectView(fake.backend, POD, OVERVIEW);
  fake.resolve(7);
  await vi.runAllTimersAsync();
  fake.send(batch(1, { overview: DOCUMENT }));
  fake.send(batch(2, { manifest: "{}" }));
  expect(view.getSnapshot().overview).toBe(DOCUMENT);
  expect(view.getSnapshot().manifest).toBe("{}");
  await vi.runAllTimersAsync();
  expect(fake.calls).toContainEqual(["object_ack", { id: 7, seq: 2 }]);
});

const USAGE: Usage = {
  state: "ready",
  sampled: "2026-11-13T10:00:00Z",
  cpu: { used: 250_000_000, request: null, limit: null, allocatable: null },
  memory: {
    used: 64 * 1024 * 1024,
    request: null,
    limit: null,
    allocatable: null,
  },
  containers: [],
};

test("a batch's usage stays until another comes, and goes with a deleted object", async () => {
  const fake = fakeBackend();
  const view = new ObjectView(fake.backend, POD, { ...OVERVIEW, usage: true });
  fake.resolve(7);
  await vi.runAllTimersAsync();
  expect(view.getSnapshot().usage).toBeUndefined();
  fake.send(batch(1, { overview: DOCUMENT, usage: USAGE }));
  fake.send(batch(2, { manifest: "{}" }));
  expect(view.getSnapshot().usage).toBe(USAGE);
  const next = { ...USAGE, sampled: "2026-11-13T10:00:15Z" };
  fake.send(batch(3, { usage: next }));
  expect(view.getSnapshot().usage).toBe(next);
  fake.send(batch(4, { exists: false }));
  expect(view.getSnapshot().usage).toBeUndefined();
});

test("an absent usage withdraws the usage, as if none had come, until a later batch brings one", async () => {
  const fake = fakeBackend();
  const view = new ObjectView(fake.backend, POD, { ...OVERVIEW, usage: true });
  fake.resolve(7);
  await vi.runAllTimersAsync();
  fake.send(batch(1, { overview: DOCUMENT, usage: USAGE }));
  expect(view.getSnapshot().usage).toBe(USAGE);
  fake.send(
    batch(2, {
      usage: {
        ...USAGE,
        state: "absent",
        sampled: null,
        cpu: { ...USAGE.cpu, used: null },
        memory: { ...USAGE.memory, used: null },
      },
    }),
  );
  expect(view.getSnapshot().usage).toBeUndefined();
  fake.send(batch(3, { manifest: "{}" }));
  expect(view.getSnapshot().usage).toBeUndefined();
  fake.send(batch(4, { usage: USAGE }));
  expect(view.getSnapshot().usage).toBe(USAGE);
});

test("the state of the last usage is kept, absent included, until the object is gone", async () => {
  const fake = fakeBackend();
  const view = new ObjectView(fake.backend, POD, { ...OVERVIEW, usage: true });
  fake.resolve(7);
  await vi.runAllTimersAsync();
  expect(view.getSnapshot().usageState).toBeNull();
  fake.send(batch(1, { overview: DOCUMENT, usage: USAGE }));
  expect(view.getSnapshot().usageState).toBe("ready");
  fake.send(batch(2, { manifest: "{}" }));
  expect(view.getSnapshot().usageState).toBe("ready");
  fake.send(batch(3, { usage: { ...USAGE, state: "absent" } }));
  expect(view.getSnapshot().usage).toBeUndefined();
  expect(view.getSnapshot().usageState).toBe("absent");
  fake.send(batch(4, { usage: { ...USAGE, state: "forbidden" } }));
  expect(view.getSnapshot().usageState).toBe("forbidden");
  fake.send(batch(5, { exists: false }));
  expect(view.getSnapshot().usageState).toBeNull();
});

test("showing the usage part asks for it, and asks again only when it changes", async () => {
  const fake = fakeBackend();
  const view = new ObjectView(fake.backend, POD, OVERVIEW);
  fake.resolve(7);
  await vi.runAllTimersAsync();
  view.setParts({ ...OVERVIEW, usage: true });
  view.setParts({ ...OVERVIEW, usage: true });
  view.setParts(OVERVIEW);
  const sent = fake.calls.filter(([command]) => command === "object_set_parts");
  expect(sent.map(([, request]) => request)).toEqual([
    { id: 7, parts: { ...OVERVIEW, usage: true } },
    { id: 7, parts: OVERVIEW },
  ]);
});

test("a deleted object drops its document", async () => {
  const fake = fakeBackend();
  const view = new ObjectView(fake.backend, POD, OVERVIEW);
  fake.resolve(1);
  await vi.runAllTimersAsync();
  fake.send(batch(1, { overview: DOCUMENT }));
  fake.send(batch(2, { exists: false }));
  expect(view.getSnapshot().exists).toBe(false);
  expect(view.getSnapshot().overview).toBeUndefined();
});

test("parts set before the id arrives go once it does", async () => {
  const fake = fakeBackend();
  const view = new ObjectView(fake.backend, POD, OVERVIEW);
  const shown = { ...OVERVIEW, manifest: true };
  view.setParts(shown);
  expect(fake.calls.some(([command]) => command === "object_set_parts")).toBe(
    false,
  );
  fake.resolve(3);
  await vi.runAllTimersAsync();
  expect(fake.calls).toContainEqual([
    "object_set_parts",
    { id: 3, parts: shown },
  ]);
  view.close();
  expect(fake.calls).toContainEqual(["object_close", 3]);
});

test("the mock answers with the recorded pod under the name asked for", async () => {
  const backend = createMockBackend("live");
  const spaces = backend.invoke("spaces_list", null);
  await vi.runAllTimersAsync();
  const [space] = await spaces;
  const view = new ObjectView(
    backend,
    { ...POD, space: space?.id ?? "" },
    OVERVIEW,
  );
  await vi.runAllTimersAsync();
  const overview = view.getSnapshot().overview;
  const metadata = overview?.sections.find(
    (section) => section.id === "core.metadata",
  )?.blocks[0];
  expect(metadata?.type === "fields" && metadata.fields[0]).toEqual({
    label: "Name",
    value: { type: "text", text: "api-0" },
  });
  const sections = overview?.sections ?? [];
  expect(sections[sections.length - 1]?.id).toBe("core.events");
  view.setParts({ ...OVERVIEW, manifest: true, related: true });
  await vi.runAllTimersAsync();
  const manifest = JSON.parse(view.getSnapshot().manifest ?? "{}") as {
    metadata: { name: string; namespace: string };
  };
  expect(manifest.metadata).toMatchObject({
    name: "api-0",
    namespace: "payments",
  });
  expect(view.getSnapshot().related?.owners[0]?.target.kind).toBe("ReplicaSet");
});

test("a batch that comes before the id is acked once the id does", async () => {
  const fake = fakeBackend();
  new ObjectView(fake.backend, POD, OVERVIEW);
  fake.send(batch(1, { overview: DOCUMENT }));
  await vi.runAllTimersAsync();
  expect(fake.calls.some(([command]) => command === "object_ack")).toBe(false);
  fake.resolve(9);
  await vi.runAllTimersAsync();
  expect(fake.calls).toContainEqual(["object_ack", { id: 9, seq: 1 }]);
});

test("a view closed before its id comes closes the object once it does", async () => {
  const fake = fakeBackend();
  const view = new ObjectView(fake.backend, POD, OVERVIEW);
  view.close();
  fake.resolve(4);
  await vi.runAllTimersAsync();
  expect(fake.calls).toContainEqual(["object_close", 4]);
});

test("values asked for before the id comes are read once it does", async () => {
  const fake = fakeBackend();
  const view = new ObjectView(fake.backend, POD, OVERVIEW);
  const read = view.values(["mode"]);
  await vi.runAllTimersAsync();
  expect(fake.calls.some(([command]) => command === "object_values")).toBe(
    false,
  );
  fake.resolve(5);
  await read;
  expect(fake.calls).toContainEqual([
    "object_values",
    { id: 5, keys: ["mode"] },
  ]);
});
