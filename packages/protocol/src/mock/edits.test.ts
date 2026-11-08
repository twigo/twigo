import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ApplyRequest, ObjectBatch, OperationEvent } from "../generated";
import { IpcError } from "../error";
import { APPLIED_LAG_MS } from "./edits";
import { createMockBackend, type MockScenario } from "./index";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const SETTINGS = {
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name: "settings", namespace: "default" },
  data: { a: "0" },
};

function edit(
  edited: unknown = { ...SETTINGS, data: { a: "1" } },
): ApplyRequest {
  return {
    space: "qa",
    opened: {
      target: {
        gvr: { group: "", version: "v1", resource: "configmaps" },
        namespaced: true,
        namespace: "default",
        name: "settings",
      },
      base: SETTINGS,
      lock: "1",
    },
    edited,
    force: false,
    drop: [],
  };
}

async function settled<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(0);
  return promise;
}

async function backendOf(scenario: MockScenario) {
  const backend = createMockBackend(scenario);
  await settled(backend.invoke("space_open", "qa"));
  return backend;
}

test("a scenario pins the answer to an edit that changes something, and an unchanged edit stays unchanged", async () => {
  for (const [scenario, state] of [
    ["applyConflicts", "conflicts"],
    ["applyStale", "stale"],
    ["applyImmutable", "immutable"],
    ["applyRecreate", "immutable"],
    ["applyRemovals", "ready"],
    ["applyMergePatch", "ready"],
    ["applyUnchanged", "unchanged"],
    ["live", "ready"],
  ] as const) {
    const backend = await backendOf(scenario);
    const answer = await settled(backend.invoke("apply_preview", edit()));
    expect(answer.state).toBe(state);
    const same = await settled(backend.invoke("apply_preview", edit(SETTINGS)));
    expect(same.state).toBe("unchanged");
  }
});

test("an edit that names another object is refused, as Rust refuses it", async () => {
  const backend = await backendOf("live");
  const caught = backend
    .invoke(
      "apply_preview",
      edit({ ...SETTINGS, metadata: { ...SETTINGS.metadata, name: "other" } }),
    )
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  await vi.advanceTimersByTimeAsync(0);
  const error = await caught;
  expect(error).toBeInstanceOf(IpcError);
  expect((error as IpcError).kind).toBe("invalidInput");
  expect((error as IpcError).message).toBe(
    'the edit names name "other", but it is an edit of "settings"',
  );
});

test("a Secret's sides of the diff hold sizes, never the values typed", async () => {
  const backend = await backendOf("live");
  const secret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "credentials", namespace: "default" },
    data: { password: "<13 bytes>" },
  };
  const request = edit({
    ...secret,
    data: { password: "<13 bytes>", token: "s3cr3t-token" },
  });
  const answer = await settled(
    backend.invoke("apply_preview", {
      ...request,
      opened: {
        target: {
          gvr: { group: "", version: "v1", resource: "secrets" },
          namespaced: true,
          namespace: "default",
          name: "credentials",
        },
        base: secret,
        lock: "1",
      },
    }),
  );
  expect(answer.state).toBe("ready");
  expect(JSON.stringify(answer)).not.toContain("s3cr3t-token");
  expect(answer).toMatchObject({
    result: { data: { password: "<13 bytes>", token: "<12 bytes>" } },
  });
});

interface Manifest {
  readonly metadata: {
    readonly resourceVersion: string;
    readonly generation?: number;
    readonly labels?: Record<string, string>;
  };
  readonly data?: Record<string, string>;
  readonly spec?: unknown;
  readonly status?: { readonly mockTick?: number };
}

const OPENED = {
  space: "qa",
  gvr: { group: "", version: "v1", resource: "configmaps" },
  namespaced: true,
  namespace: "default",
  name: "settings",
};

async function opened(
  backend: ReturnType<typeof createMockBackend>,
  object = OPENED,
) {
  const batches: ObjectBatch[] = [];
  await settled(
    backend.subscribe(
      "object_open",
      {
        object,
        parts: {
          overview: false,
          manifest: true,
          events: false,
          related: false,
        },
      },
      (batch) => batches.push(batch),
    ),
  );
  await vi.advanceTimersByTimeAsync(10);
  const manifests = () =>
    batches.flatMap(({ manifest }) =>
      manifest === null ? [] : [JSON.parse(manifest) as Manifest],
    );
  return { manifests, latest: () => manifests()[manifests().length - 1] };
}

/** Previews `edited` against the object as opened, plans it and runs the plan. */
async function applyEdit(
  backend: ReturnType<typeof createMockBackend>,
  first: Manifest,
  edited: unknown,
): Promise<OperationEvent[]> {
  const answer = await settled(
    backend.invoke("apply_preview", {
      space: "qa",
      opened: {
        target: {
          gvr: OPENED.gvr,
          namespaced: true,
          namespace: "default",
          name: "settings",
        },
        base: first,
        lock: first.metadata.resourceVersion,
      },
      edited,
      force: false,
      drop: [],
    }),
  );
  if (answer.state !== "ready") throw new Error(answer.state);
  const events: OperationEvent[] = [];
  const plan = await settled(
    backend.invoke("command_plan", {
      action: "apply",
      space: "qa",
      preview: answer.id,
    }),
  );
  await vi.advanceTimersByTimeAsync(
    plan.friction.kind === "countdown" ? 6000 : 0,
  );
  void backend.subscribe(
    "command_execute",
    {
      plan: plan.id,
      typed: plan.friction.kind === "typed" ? plan.friction.text : null,
    },
    (event) => events.push(event),
  );
  await vi.advanceTimersByTimeAsync(10);
  return events;
}

test("an applied edit leaves the object, for the one open and the next to open", async () => {
  const backend = await backendOf("live");
  const object = await opened(backend);
  const first = object.latest();
  if (first === undefined) throw new Error("the object did not open");

  const events = await applyEdit(backend, first, {
    ...first,
    data: { changed: "yes" },
  });
  expect(events[events.length - 1]?.state).toBe("done");

  const now = object.latest();
  expect(now?.data).toEqual({ changed: "yes" });
  expect(now?.metadata.resourceVersion).not.toBe(
    first.metadata.resourceVersion,
  );
  const next = await opened(backend);
  expect(next.latest()?.data).toEqual({ changed: "yes" });
});

test("applyLate leaves the applied object after the plan is done", async () => {
  const backend = await backendOf("applyLate");
  const object = await opened(backend);
  const first = object.latest();
  if (first === undefined) throw new Error("the object did not open");

  const events = await applyEdit(backend, first, {
    ...first,
    data: { changed: "yes" },
  });
  expect(events[events.length - 1]?.state).toBe("done");
  expect(object.latest()?.data).toEqual(first.data);

  await vi.advanceTimersByTimeAsync(APPLIED_LAG_MS);
  expect(object.latest()?.data).toEqual({ changed: "yes" });
  expect(object.latest()?.metadata.resourceVersion).not.toBe(
    first.metadata.resourceVersion,
  );
});

test("serverChange has a colleague edit the open object, and statusChange only a controller write its status", async () => {
  const server = await backendOf("serverChange");
  const object = await opened(server, {
    ...OPENED,
    gvr: { group: "apps", version: "v1", resource: "deployments" },
    name: "web",
    namespace: "overview",
  });
  const before = object.latest();
  expect(object.manifests()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(4100);
  const after = object.latest();
  expect(object.manifests()).toHaveLength(2);
  expect(after?.metadata.labels?.["edited-by"]).toBe("colleague-1");
  expect(after?.metadata.resourceVersion).not.toBe(
    before?.metadata.resourceVersion,
  );
  expect(after?.spec).toEqual(before?.spec);

  const status = await backendOf("statusChange");
  const watched = await opened(status, {
    ...OPENED,
    gvr: { group: "apps", version: "v1", resource: "deployments" },
    name: "web",
    namespace: "overview",
  });
  const start = watched.latest();
  await vi.advanceTimersByTimeAsync(4100);
  const written = watched.latest();
  expect(written?.status?.mockTick).toBe(1);
  expect(written?.metadata.labels).toEqual(start?.metadata.labels);
  expect(written?.metadata.generation).toBe(start?.metadata.generation);
  expect(written?.metadata.resourceVersion).not.toBe(
    start?.metadata.resourceVersion,
  );

  const plain = await backendOf("live");
  const quiet = await opened(plain, {
    ...OPENED,
    gvr: { group: "apps", version: "v1", resource: "deployments" },
    name: "web",
    namespace: "overview",
  });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(quiet.manifests()).toHaveLength(1);
});
