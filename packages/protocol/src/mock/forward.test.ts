import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { IpcError } from "../error";
import type { Backend } from "../backend";
import type {
  ContextAccess,
  Forward,
  ForwardEvent,
  ForwardStarted,
  ForwardTarget,
  Gvr,
} from "../generated";
import { Cluster, deploymentOf } from "./cluster";
import { POD_COUNT } from "./fixtures";
import {
  BLOCKED_AFTER_MS,
  createMockBackend,
  FIRST_CONNECTION_AFTER_MS,
  LIFTS_AFTER_MS,
  LOSES_POD_AFTER_MS,
  READY_AFTER_MS,
  RECONNECTS_FOR_MS,
  type MockScenario,
} from "./index";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const PODS: Gvr = { group: "", version: "v1", resource: "pods" };
const SERVICES: Gvr = { group: "", version: "v1", resource: "services" };
const DEPLOYMENTS: Gvr = {
  group: "apps",
  version: "v1",
  resource: "deployments",
};

const pod = (() => {
  const found = new Cluster("qa", POD_COUNT.qa ?? 0, 0).pods.find(
    (candidate) =>
      candidate.status === "Running" &&
      !deploymentOf(candidate).endsWith("gateway"),
  );
  if (!found) throw new Error("qa has no running pod");
  return found;
})();

const POD: ForwardTarget = {
  space: "qa",
  gvr: PODS,
  namespace: pod.namespace,
  name: pod.name,
};
const SERVICE: ForwardTarget = {
  space: "qa",
  gvr: SERVICES,
  namespace: pod.namespace,
  name: deploymentOf(pod),
};
const GATEWAY: ForwardTarget = {
  ...SERVICE,
  name: `${pod.namespace}-gateway`,
};

async function answered<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(0);
  return promise;
}

async function refused(promise: Promise<unknown>): Promise<IpcError> {
  const caught = promise.then(
    () => {
      throw new Error("it was not refused");
    },
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(0);
  const error = await caught;
  expect(error).toBeInstanceOf(IpcError);
  return error as IpcError;
}

interface Followed {
  readonly backend: Backend;
  readonly first: Forward[];
  readonly events: ForwardEvent[];
  /** The forward as the latest event of it says. */
  readonly latest: (id: number) => Forward | undefined;
  readonly start: (
    target: ForwardTarget,
    port: number,
    local?: number,
  ) => Promise<ForwardStarted>;
}

async function followed(scenario: MockScenario = "live"): Promise<Followed> {
  const backend = createMockBackend(scenario);
  await answered(backend.invoke("space_open", "qa"));
  const events: ForwardEvent[] = [];
  const first = await answered(
    backend.subscribe("forwards_watch", null, (event) => {
      events.push(event);
    }),
  );
  return {
    backend,
    first,
    events,
    latest: (id) => {
      const mine = events.filter(
        (event) =>
          (event.event === "changed" ? event.forward.id : event.id) === id,
      );
      const last = mine[mine.length - 1];
      return last?.event === "changed" ? last.forward : undefined;
    },
    start: (target, port, local) =>
      answered(
        backend.invoke("forward_start", { target, port, local: local ?? null }),
      ),
  };
}

function started(answer: ForwardStarted): Forward {
  if (answer.outcome !== "started") throw new Error("the start was busy");
  return answer.forward;
}

test("a Service's ports come with their target ports, and the default is the one named for HTTP", async () => {
  const { backend } = await followed();
  const recorded = await answered(backend.invoke("forward_ports", SERVICE));
  expect(recorded.kind).toBe("Service");
  expect(recorded.ports).toEqual([
    {
      port: 80,
      name: "http",
      targetPort: "http",
      container: null,
      appProtocol: null,
      local: 8080,
      forward: null,
    },
  ]);

  const gateway = await answered(backend.invoke("forward_ports", GATEWAY));
  expect(
    gateway.ports.map(({ port, name, local }) => [port, name, local]),
  ).toEqual([
    [9090, "metrics", 9090],
    [80, "http", 8080],
    [9000, "grpc", 9000],
  ]);
  expect(gateway.default).toBe(80);
});

test("a workload's ports are its template's, and one that declares none is refused in words", async () => {
  const { backend } = await followed();
  const deployment = await answered(
    backend.invoke("forward_ports", { ...SERVICE, gvr: DEPLOYMENTS }),
  );
  expect(deployment.kind).toBe("Deployment");
  expect(
    deployment.ports.map(({ port, container }) => [port, container]),
  ).toEqual([[8080, "app"]]);

  const gateway = await answered(
    backend.invoke("forward_ports", {
      ...GATEWAY,
      gvr: DEPLOYMENTS,
      name: "payments-gateway",
      namespace: "payments",
    }),
  );
  expect(
    gateway.ports.map(({ port, name, container }) => [port, name, container]),
  ).toEqual([
    [9090, "metrics", "app"],
    [8080, "http", "app"],
    [50051, "grpc", "app"],
  ]);
  expect(gateway.default).toBe(8080);
});

test("a start is listed starting, then ready on a pod of its target, and its counters move", async () => {
  const { events, latest, start, first } = await followed();
  expect(first).toEqual([]);
  const forward = started(await start(SERVICE, 80));
  expect(forward).toMatchObject({
    kind: "Service",
    port: 80,
    portName: "http",
    local: 8080,
    addresses: ["127.0.0.1", "::1"],
    state: { state: "starting" },
    pod: null,
  });
  expect(events[0]).toEqual({ event: "changed", forward });

  await vi.advanceTimersByTimeAsync(READY_AFTER_MS);
  const ready = latest(forward.id);
  expect(ready?.state).toEqual({ state: "ready" });
  expect(ready?.pod).toMatch(new RegExp(`^${deploymentOf(pod)}-`));
  expect(ready?.podPort).toBe(8080);

  await vi.advanceTimersByTimeAsync(10_000);
  const later = latest(forward.id);
  expect(later?.sent).toBeGreaterThan(0);
  expect(later?.received).toBeGreaterThan(0);
  const connections = events.flatMap((event) =>
    event.event === "changed" && event.forward.id === forward.id
      ? [event.forward.connections]
      : [],
  );
  expect(new Set(connections).size).toBeGreaterThan(1);
});

test("a local port that another forward holds is busy, with the next free one, and nothing starts", async () => {
  const { start, events } = await followed();
  started(await start(SERVICE, 80));
  const busy = await start(GATEWAY, 80);
  expect(busy).toEqual({
    outcome: "busy",
    local: 8080,
    why: "inUse",
    free: 8081,
  });
  expect(events).toHaveLength(1);
});

test("a port below 1024 is not permitted, and the free port offered starts at 1024", async () => {
  const { start, events } = await followed();
  const busy = await start(SERVICE, 80, 80);
  expect(busy).toEqual({
    outcome: "busy",
    local: 80,
    why: "notPermitted",
    free: 1024,
  });
  expect(events).toEqual([]);
});

test("a stopped forward keeps its row and its port is free, and a start brings it back", async () => {
  const { backend, start, latest } = await followed();
  const forward = started(await start(SERVICE, 80));
  await vi.advanceTimersByTimeAsync(READY_AFTER_MS);
  await answered(backend.invoke("forward_stop", forward.id));
  expect(latest(forward.id)).toMatchObject({
    state: { state: "stopped" },
    pod: null,
    connections: 0,
  });
  await vi.advanceTimersByTimeAsync(5000);
  expect(latest(forward.id)?.state).toEqual({ state: "stopped" });

  expect(await start(GATEWAY, 80)).toMatchObject({
    outcome: "started",
    forward: { local: 8080 },
  });
  const busy = await start(SERVICE, 80);
  expect(busy).toMatchObject({ outcome: "busy", why: "inUse" });
});

test("resume starts a stopped forward on another port when asked, and a busy port changes nothing", async () => {
  const { backend, start, latest, events } = await followed();
  const forward = started(await start(SERVICE, 80));
  await answered(backend.invoke("forward_stop", forward.id));
  const other = started(await start(GATEWAY, 80));
  expect(other.local).toBe(8080);
  const before = events.length;
  const busy = await answered(
    backend.invoke("forward_resume", { id: forward.id, local: 8080 }),
  );
  expect(busy).toMatchObject({ outcome: "busy", why: "inUse", free: 8081 });
  expect(events).toHaveLength(before);

  const resumed = await answered(
    backend.invoke("forward_resume", { id: forward.id, local: 8090 }),
  );
  expect(resumed).toMatchObject({
    outcome: "started",
    forward: { id: forward.id, local: 8090, state: { state: "starting" } },
  });
  await vi.advanceTimersByTimeAsync(READY_AFTER_MS);
  expect(latest(forward.id)).toMatchObject({
    local: 8090,
    state: { state: "ready" },
  });
});

test("a running forward moves to another local port and keeps its state, its pod and its connections", async () => {
  const { backend, start, latest, events } = await followed();
  const forward = started(await start(SERVICE, 80));
  await vi.advanceTimersByTimeAsync(READY_AFTER_MS + 1000);
  const before = latest(forward.id);
  expect(before).toMatchObject({ state: { state: "ready" }, connections: 1 });

  const moved = await answered(
    backend.invoke("forward_resume", { id: forward.id, local: 8091 }),
  );
  expect(moved).toMatchObject({
    outcome: "started",
    forward: {
      id: forward.id,
      local: 8091,
      state: { state: "ready" },
      pod: before?.pod,
      connections: 1,
    },
  });
  const states = events.flatMap((event) =>
    event.event === "changed" ? [event.forward.state.state] : [],
  );
  expect(states.filter((state) => state === "starting")).toHaveLength(1);

  await vi.advanceTimersByTimeAsync(READY_AFTER_MS);
  expect(latest(forward.id)).toMatchObject({
    local: 8091,
    state: { state: "ready" },
  });
});

test("a resume leaves a ready forward as it is, answering it, with no change told", async () => {
  const { backend, start, latest, events } = await followed();
  const forward = started(await start(SERVICE, 80));
  await vi.advanceTimersByTimeAsync(READY_AFTER_MS);
  const ready = latest(forward.id);
  const before = events.length;
  const answer = await answered(
    backend.invoke("forward_resume", { id: forward.id, local: null }),
  );
  expect(answer).toEqual({ outcome: "started", forward: ready });
  expect(events).toHaveLength(before);
});

test("remove forgets a forward but the local port it had stays remembered", async () => {
  const { backend, start, events } = await followed();
  const forward = started(await start(SERVICE, 80, 8085));
  await answered(backend.invoke("forward_remove", forward.id));
  expect(events[events.length - 1]).toEqual({
    event: "removed",
    id: forward.id,
  });
  const ports = await answered(backend.invoke("forward_ports", SERVICE));
  expect(ports.ports[0]).toMatchObject({ local: 8085, forward: null });
  const error = await refused(backend.invoke("forward_stop", forward.id));
  expect(error.kind).toBe("notFound");
});

test("a resume leaves a reconnecting forward reconnecting, and it is ready on another pod when its wait ends", async () => {
  const { backend, start, latest, events } = await followed(
    "forwardReconnecting",
  );
  const forward = started(await start(SERVICE, 80));
  await vi.advanceTimersByTimeAsync(READY_AFTER_MS + LOSES_POD_AFTER_MS);
  const lost = latest(forward.id);
  expect(lost?.state.state).toBe("reconnecting");
  const before = events.length;
  const answer = await answered(
    backend.invoke("forward_resume", { id: forward.id, local: null }),
  );
  expect(answer).toEqual({ outcome: "started", forward: lost });
  expect(events).toHaveLength(before);
  await vi.advanceTimersByTimeAsync(RECONNECTS_FOR_MS);
  expect(latest(forward.id)?.state).toEqual({ state: "ready" });
});

test("forwardRestored's restored forward leaves by its first connection after 20 s: ready on a pod, its counters moving", async () => {
  const { latest } = await followed("forwardRestored");
  await vi.advanceTimersByTimeAsync(FIRST_CONNECTION_AFTER_MS - 1);
  expect(latest(1)).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(latest(1)).toMatchObject({
    state: { state: "ready" },
    podPort: 8080,
    connections: 0,
  });
  expect(latest(1)?.pod).toMatch(/^payments-api-/);
  await vi.advanceTimersByTimeAsync(3000);
  expect(latest(1)?.sent).toBeGreaterThan(0);
  expect(latest(2)).toBeUndefined();
  expect(latest(3)).toBeUndefined();
});

test("a resume leaves a restored forward restored, and its first connection still comes on time", async () => {
  const { backend, latest, events } = await followed("forwardRestored");
  await vi.advanceTimersByTimeAsync(5000);
  const answer = await answered(
    backend.invoke("forward_resume", { id: 1, local: null }),
  );
  expect(answer).toMatchObject({
    outcome: "started",
    forward: { id: 1, state: { state: "restored" } },
  });
  expect(events).toEqual([]);
  await vi.advanceTimersByTimeAsync(FIRST_CONNECTION_AFTER_MS - 5000);
  expect(latest(1)?.state).toEqual({ state: "ready" });
});

test("forwardRestored's stopped forward starts again, and its failed one fails again, in words", async () => {
  const { backend, latest } = await followed("forwardRestored");
  await answered(backend.invoke("forward_resume", { id: 2, local: null }));
  await vi.advanceTimersByTimeAsync(READY_AFTER_MS);
  expect(latest(2)?.state).toEqual({ state: "ready" });
  await answered(backend.invoke("forward_resume", { id: 3, local: null }));
  await vi.advanceTimersByTimeAsync(READY_AFTER_MS);
  expect(latest(3)?.state).toMatchObject({
    state: "failed",
    error: { message: 'deployments.apps "payments-legacy" not found' },
  });
});

const POLICY = "/Library/Application Support/Twigo/policy.json";

async function accessOf(backend: Backend, name: string) {
  let found: ContextAccess | undefined;
  const first = await answered(
    backend.subscribe("contexts_watch", null, (contexts) => {
      found = contexts.find((context) => context.name === name)?.access;
    }),
  );
  found = first.find((context) => context.name === name)?.access;
  return () => found;
}

test("forwardBlocked forbids forwards by a policy file 8 s after a forward is ready, and the forward says why", async () => {
  const { backend, start, latest } = await followed("forwardBlocked");
  const access = await accessOf(backend, "qa");
  const forward = started(await start(SERVICE, 80));
  await vi.advanceTimersByTimeAsync(READY_AFTER_MS + BLOCKED_AFTER_MS - 1);
  expect(latest(forward.id)?.state).toEqual({ state: "ready" });
  expect(access()?.mode).toBe("read-write");
  await vi.advanceTimersByTimeAsync(1);
  const state = latest(forward.id)?.state;
  expect(state).toMatchObject({
    state: "failed",
    error: {
      kind: "permissions",
      blocked: {
        context: "qa",
        mode: "read-only",
        class: "forward",
        reason: "mode",
        verb: "get",
        target: `pods/portforward in ${pod.namespace}`,
        source: { kind: "policyFile", file: POLICY, pattern: "qa" },
      },
    },
  });
  if (state?.state !== "failed") throw new Error("not failed");
  expect(state.error.message).toBe(
    `qa is read-only by qa in ${POLICY}, so Twigo did not send get pods/portforward in ${pod.namespace}`,
  );
  expect(latest(forward.id)).toMatchObject({
    pod: null,
    connections: 0,
    local: 8080,
  });
  expect(access()).toMatchObject({
    mode: "read-only",
    source: { kind: "policyFile" },
  });
});

test("a start, a resume and a move that the mode refuses answer its error and change nothing", async () => {
  const { backend, start, latest, events } = await followed("forwardBlocked");
  const forward = started(await start(SERVICE, 80));
  const stopped = started(await start(GATEWAY, 80, 8099));
  await vi.advanceTimersByTimeAsync(READY_AFTER_MS);
  await answered(backend.invoke("forward_stop", stopped.id));
  await vi.advanceTimersByTimeAsync(BLOCKED_AFTER_MS);
  expect(latest(forward.id)?.state.state).toBe("failed");
  const before = events.length;

  const fresh = await refused(
    backend.invoke("forward_start", {
      target: GATEWAY,
      port: 9090,
      local: null,
    }),
  );
  expect(fresh).toMatchObject({
    kind: "permissions",
    blocked: { class: "forward", reason: "mode", mode: "read-only" },
  });
  const wrongPort = await refused(
    backend.invoke("forward_start", { target: SERVICE, port: 9999, local: 1 }),
  );
  expect(wrongPort.kind).toBe("permissions");
  for (const request of [
    { id: forward.id, local: null },
    { id: forward.id, local: 8091 },
    { id: stopped.id, local: null },
  ]) {
    const error = await refused(backend.invoke("forward_resume", request));
    expect(error.kind).toBe("permissions");
  }
  const again = await refused(
    backend.invoke("forward_start", { target: SERVICE, port: 80, local: null }),
  );
  expect(again.kind).toBe("permissions");

  expect(events).toHaveLength(before);
  expect(latest(forward.id)).toMatchObject({
    local: 8080,
    state: { state: "failed" },
  });
  expect(latest(stopped.id)).toMatchObject({
    local: 8099,
    state: { state: "stopped" },
  });

  await vi.advanceTimersByTimeAsync(LIFTS_AFTER_MS);
  const next = started(await start(GATEWAY, 9090));
  expect(next.id).toBe(stopped.id + 1);
});

test("forwardBlocked lifts the lock 15 s later: what was refused waits, restored, and its first connection makes it ready", async () => {
  const { backend, start, latest } = await followed("forwardBlocked");
  const access = await accessOf(backend, "qa");
  const forward = started(await start(SERVICE, 80));
  await vi.advanceTimersByTimeAsync(READY_AFTER_MS + BLOCKED_AFTER_MS);
  expect(latest(forward.id)?.state.state).toBe("failed");

  await vi.advanceTimersByTimeAsync(LIFTS_AFTER_MS - 1);
  expect(latest(forward.id)?.state.state).toBe("failed");
  expect(access()?.mode).toBe("read-only");
  await vi.advanceTimersByTimeAsync(1);
  expect(latest(forward.id)).toMatchObject({
    state: { state: "restored" },
    pod: null,
    local: 8080,
  });
  expect(access()).toMatchObject({
    mode: "read-write",
    source: { kind: "default" },
  });

  await vi.advanceTimersByTimeAsync(FIRST_CONNECTION_AFTER_MS - 1);
  expect(latest(forward.id)?.state).toEqual({ state: "restored" });
  await vi.advanceTimersByTimeAsync(1);
  expect(latest(forward.id)?.state).toEqual({ state: "ready" });
  expect(latest(forward.id)?.pod).toBeTruthy();

  await vi.advanceTimersByTimeAsync(BLOCKED_AFTER_MS + LIFTS_AFTER_MS);
  expect(latest(forward.id)?.state).toEqual({ state: "ready" });
  const later = started(await start(GATEWAY, 80, 8099));
  await vi.advanceTimersByTimeAsync(READY_AFTER_MS + BLOCKED_AFTER_MS + 1);
  expect(latest(later.id)?.state).toEqual({ state: "ready" });
});

const API: ForwardTarget = {
  space: "prod-eu",
  gvr: DEPLOYMENTS,
  namespace: "payments",
  name: "payments-api",
};
const PAYMENTS_GATEWAY: ForwardTarget = {
  ...API,
  gvr: SERVICES,
  name: "payments-gateway",
};

test("a port that has a forward answers that forward's local port, which a restored forward's seed remembers", async () => {
  const { backend } = await followed("forwardRestored");
  const api = await answered(backend.invoke("forward_ports", API));
  expect(api.ports[0]).toMatchObject({ port: 8080, local: 8081, forward: 1 });
  const gateway = await answered(
    backend.invoke("forward_ports", PAYMENTS_GATEWAY),
  );
  expect(gateway.ports.find(({ port }) => port === 9090)).toMatchObject({
    local: 9090,
    forward: 2,
  });

  await answered(backend.invoke("forward_remove", 1));
  const removed = await answered(backend.invoke("forward_ports", API));
  expect(removed.ports[0]).toMatchObject({ local: 8081, forward: null });
});

test("a reconnecting pod target waits for that pod, and only a Service or a workload for another", async () => {
  const { latest, start } = await followed("forwardReconnecting");
  const forward = started(await start(POD, 8080));
  await vi.advanceTimersByTimeAsync(READY_AFTER_MS + LOSES_POD_AFTER_MS);
  const lost = latest(forward.id)?.state;
  expect(lost).toEqual({
    state: "reconnecting",
    reason: `pod ${pod.name} is not ready; waiting for it`,
  });
  await vi.advanceTimersByTimeAsync(RECONNECTS_FOR_MS);
  expect(latest(forward.id)).toMatchObject({
    state: { state: "ready" },
    pod: pod.name,
  });

  const service = started(await start(SERVICE, 80, 8099));
  await vi.advanceTimersByTimeAsync(READY_AFTER_MS + LOSES_POD_AFTER_MS);
  const behind = latest(service.id)?.state;
  expect(behind).toMatchObject({ state: "reconnecting" });
  expect(behind).toMatchObject({
    reason: expect.stringContaining("waiting for another ready pod") as string,
  });
});
