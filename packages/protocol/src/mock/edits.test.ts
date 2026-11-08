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
    ["applyListsMoved", "stale"],
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

const conflicting = (
  overrides: Partial<Pick<ApplyRequest, "force" | "drop">>,
): ApplyRequest => ({ ...edit(), ...overrides });

test("Force takes the conflicting fields and giving up all of them leaves nothing to send, as Rust answers", async () => {
  const backend = await backendOf("applyConflicts");
  const paths = [".spec.replicas", ".metadata.labels.team"];
  expect(
    (await settled(backend.invoke("apply_preview", conflicting({})))).state,
  ).toBe("conflicts");
  expect(
    (
      await settled(
        backend.invoke("apply_preview", conflicting({ force: true })),
      )
    ).state,
  ).toBe("ready");
  expect(
    await settled(
      backend.invoke("apply_preview", conflicting({ drop: paths })),
    ),
  ).toEqual({ state: "unchanged", ignored: [] });
  expect(
    await settled(
      backend.invoke("apply_preview", conflicting({ drop: [paths[0] ?? ""] })),
    ),
  ).toEqual({
    state: "conflicts",
    conflicts: [
      { path: ".metadata.labels.team", manager: "kubectl-client-side-apply" },
    ],
  });
});

test("a stale answer says whether Keep mine can answer it, and Keep mine then gets a ready one", async () => {
  const stale = await backendOf("applyStale");
  const first = await settled(stale.invoke("apply_preview", edit()));
  expect(first).toMatchObject({ state: "stale", keepable: true });
  const kept = edit();
  const answer = await settled(
    stale.invoke("apply_preview", {
      ...kept,
      opened: kept.opened && { ...kept.opened, lock: "2", locked: SETTINGS },
    }),
  );
  expect(answer.state).toBe("ready");

  const moved = await backendOf("applyListsMoved");
  expect(await settled(moved.invoke("apply_preview", edit()))).toMatchObject({
    state: "stale",
    keepable: false,
    message: expect.stringContaining("sends it whole") as unknown,
  });
});

test("a lock the object has moved from answers stale, and the new version Keep mine locked to does not", async () => {
  const backend = await backendOf("live");
  const object = await opened(backend);
  const first = object.latest();
  if (first === undefined) throw new Error("the object did not open");
  await applyEdit(backend, first, { ...first, data: { changed: "yes" } });
  const now = object.latest();
  if (now === undefined) throw new Error("the object did not change");

  const mine = { ...now, data: { changed: "mine" } };
  const request = (lock: string, locked?: unknown): ApplyRequest => {
    const base = edit(mine);
    return {
      ...base,
      opened: base.opened && {
        ...base.opened,
        base: first,
        lock,
        ...(locked !== undefined && { locked }),
      },
    };
  };
  const old = await settled(
    backend.invoke("apply_preview", request(first.metadata.resourceVersion)),
  );
  expect(old).toMatchObject({ state: "stale", keepable: true });
  const kept = await settled(
    backend.invoke("apply_preview", request(now.metadata.resourceVersion, now)),
  );
  expect(kept.state).toBe("ready");
});

test("a refused edit ends the plans of older previews of its object, and a namespaced kind with no namespace is refused", async () => {
  const backend = await backendOf("live");
  const ready = await settled(backend.invoke("apply_preview", edit()));
  if (ready.state !== "ready") throw new Error(ready.state);
  const refused = await settled(
    backend
      .invoke(
        "apply_preview",
        edit({
          ...SETTINGS,
          metadata: { ...SETTINGS.metadata, name: "other" },
        }),
      )
      .catch((error: unknown) => error),
  );
  expect(refused).toBeInstanceOf(IpcError);
  const planned = await settled(
    backend
      .invoke("command_plan", {
        action: "apply",
        space: "qa",
        preview: ready.id,
      })
      .catch((error: unknown) => error),
  );
  expect(planned).toBeInstanceOf(IpcError);
  expect((planned as IpcError).message).toBe(
    `no preview ${String(ready.id)} waits to apply`,
  );

  const unnamespaced = await settled(
    backend
      .invoke("apply_preview", {
        space: "qa",
        opened: null,
        edited: {
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: { name: "fresh" },
        },
        force: false,
        drop: [],
      })
      .catch((error: unknown) => error),
  );
  expect(unnamespaced).toBeInstanceOf(IpcError);
  expect((unnamespaced as IpcError).message).toBe("fresh names no namespace");
});
