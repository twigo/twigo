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
  FAILS_AFTER_MS,
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
const STATEFULSETS: Gvr = {
  group: "apps",
  version: "v1",
  resource: "statefulsets",
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

test("a pod's ports are its containers' TCP ports, with the local port a start takes", async () => {
  const { backend } = await followed();
  const ports = await answered(backend.invoke("forward_ports", POD));
  expect(ports).toEqual({
    kind: "Pod",
    ports: [
      {
        port: 8080,
        name: "http",
        targetPort: null,
        container: "app",
        appProtocol: null,
        local: 8080,
        forward: null,
      },
    ],
    default: 8080,
  });
});

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

  const error = await refused(
    backend.invoke("forward_ports", {
      ...SERVICE,
      gvr: STATEFULSETS,
      name: "db",
    }),
  );
  expect(error.kind).toBe("invalidInput");
  expect(error.message).toBe("StatefulSet db declares no TCP port to forward");
});

test("a target of another kind, a pod or a Deployment the cluster lacks, and a port it does not declare are refused", async () => {
  const { backend } = await followed();
  const configMap = await refused(
    backend.invoke("forward_ports", {
      ...POD,
      gvr: { group: "", version: "v1", resource: "configmaps" },
    }),
  );
  expect(configMap.kind).toBe("invalidInput");
  const gone = await refused(
    backend.invoke("forward_ports", { ...POD, name: "ghost" }),
  );
  expect(gone.message).toBe('pods "ghost" not found');
  const noDeployment = await refused(
    backend.invoke("forward_ports", {
      ...SERVICE,
      gvr: DEPLOYMENTS,
      name: "ghost",
    }),
  );
  expect(noDeployment.message).toBe('deployments.apps "ghost" not found');
  const wrongPort = await refused(
    backend.invoke("forward_start", { target: POD, port: 9999, local: null }),
  );
  expect(wrongPort.message).toBe(`${pod.name} declares no port 9999`);
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

test("a forward carries the appProtocol its port declares", async () => {
  const { backend, start, latest } = await followed();
  const grpc = started(await start(GATEWAY, 9000));
  expect(grpc.appProtocol).toBe("grpc");
  const http = started(await start(GATEWAY, 80, 8081));
  expect(http.appProtocol).toBeNull();
  expect(started(await start(GATEWAY, 9090)).appProtocol).toBe("http");
  await vi.advanceTimersByTimeAsync(READY_AFTER_MS);
  expect(latest(grpc.id)?.appProtocol).toBe("grpc");
  const ports = await answered(backend.invoke("forward_ports", GATEWAY));
  expect(
    ports.ports.map(({ port, appProtocol }) => [port, appProtocol]),
  ).toEqual([
    [9090, "http"],
    [80, null],
    [9000, "grpc"],
  ]);
});

test("a workload's container ports declare no appProtocol, as Kubernetes has none for them", async () => {
  const { backend, start } = await followed();
  const deployment = {
    ...GATEWAY,
    gvr: DEPLOYMENTS,
    name: "payments-gateway",
    namespace: "payments",
  };
  const ports = await answered(backend.invoke("forward_ports", deployment));
  expect(ports.ports.map(({ appProtocol }) => appProtocol)).toEqual([
    null,
    null,
    null,
  ]);
  expect(started(await start(deployment, 50051)).appProtocol).toBeNull();
});

test("a pod target forwards to itself", async () => {
  const { latest, start } = await followed();
  const forward = started(await start(POD, 8080));
  await vi.advanceTimersByTimeAsync(READY_AFTER_MS);
  expect(latest(forward.id)).toMatchObject({ pod: pod.name, podPort: 8080 });
});

test("a start of a port that has a forward answers with that forward, and the ports say which", async () => {
  const { backend, start, events } = await followed();
  const forward = started(await start(SERVICE, 80));
  const again = started(await start(SERVICE, 80));
  expect(again.id).toBe(forward.id);
  expect(events.filter((event) => event.event === "changed")).toHaveLength(1);
  const ports = await answered(backend.invoke("forward_ports", SERVICE));
  expect(ports.ports[0]?.forward).toBe(forward.id);
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

test("a move to a port that is taken answers busy and leaves the forward where it is", async () => {
  const { backend, start, latest, events } = await followed();
  const forward = started(await start(SERVICE, 80));
  started(await start(GATEWAY, 80, 8090));
  await vi.advanceTimersByTimeAsync(READY_AFTER_MS);
  const before = events.length;
  const busy = await answered(
    backend.invoke("forward_resume", { id: forward.id, local: 8090 }),
  );
  expect(busy).toMatchObject({ outcome: "busy", why: "inUse", free: 8091 });
  expect(events).toHaveLength(before);
  expect(latest(forward.id)).toMatchObject({
    local: 8080,
    state: { state: "ready" },
  });
});

test("a start of a port that has a forward answers it, moved when another local port is asked", async () => {
  const { backend, start, latest, events } = await followed();
  const forward = started(await start(SERVICE, 80));
  await vi.advanceTimersByTimeAsync(READY_AFTER_MS);
  const before = events.length;
  expect(started(await start(SERVICE, 80))).toBe(latest(forward.id));
  expect(events).toHaveLength(before);

  const moved = started(await start(SERVICE, 80, 8090));
  expect(moved).toMatchObject({
    id: forward.id,
    local: 8090,
    state: { state: "ready" },
  });
  expect(latest(forward.id)?.local).toBe(8090);
  const ports = await answered(backend.invoke("forward_ports", SERVICE));
  expect(ports.ports[0]).toMatchObject({ local: 8090, forward: forward.id });
  expect(await start(GATEWAY, 80, 8090)).toMatchObject({
    outcome: "busy",
    why: "inUse",
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

test("a later follower replaces an earlier one and is told everything", async () => {
  const { backend, start, events } = await followed();
  const forward = started(await start(SERVICE, 80));
  const second: ForwardEvent[] = [];
  const all = await answered(
    backend.subscribe("forwards_watch", null, (event) => {
      second.push(event);
    }),
  );
  expect(all.map(({ id }) => id)).toEqual([forward.id]);
  const before = events.length;
  await vi.advanceTimersByTimeAsync(READY_AFTER_MS);
  expect(events).toHaveLength(before);
  expect(second.length).toBeGreaterThan(0);
});

test("forwardBusy holds 8080 for another process, whatever else is free", async () => {
  const { start, events } = await followed("forwardBusy");
  expect(await start(SERVICE, 80)).toEqual({
    outcome: "busy",
    local: 8080,
    why: "inUse",
    free: 8081,
  });
  expect(events).toEqual([]);
  expect(await start(SERVICE, 80, 8081)).toMatchObject({ outcome: "started" });
});

test("forwardReconnecting loses the pod after 8 s, says why for 5 s, and is ready on another", async () => {
  const { start, latest } = await followed("forwardReconnecting");
  const forward = started(await start(SERVICE, 80));
  await vi.advanceTimersByTimeAsync(READY_AFTER_MS);
  const before = latest(forward.id)?.pod;
  expect(before).toBeTruthy();

  await vi.advanceTimersByTimeAsync(LOSES_POD_AFTER_MS);
  const lost = latest(forward.id);
  expect(lost).toMatchObject({ pod: null, connections: 0 });
  expect(lost?.state).toEqual({
    state: "reconnecting",
    reason: `pod ${before ?? ""} is gone; waiting for another ready pod`,
  });

  await vi.advanceTimersByTimeAsync(RECONNECTS_FOR_MS);
  const after = latest(forward.id);
  expect(after?.state).toEqual({ state: "ready" });
  expect(after?.pod).toBeTruthy();
  expect(after?.pod).not.toBe(before);

  await vi.advanceTimersByTimeAsync(LOSES_POD_AFTER_MS + 1);
  expect(latest(forward.id)?.state).toEqual({ state: "ready" });
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

test("forwardFailed fails a start because nothing listens on the pod's port, and still listens", async () => {
  const { start, latest } = await followed("forwardFailed");
  const forward = started(await start(POD, 8080));
  await vi.advanceTimersByTimeAsync(FAILS_AFTER_MS);
  expect(latest(forward.id)?.state).toEqual({
    state: "failed",
    error: {
      kind: "unavailable",
      message: `pod ${pod.name} refused the connection to port 8080: nothing listens on it`,
    },
  });
  const busy = await start(GATEWAY, 80, 8080);
  expect(busy).toMatchObject({ outcome: "busy", why: "inUse" });
});

test("forwardQueued has connections wait for a place among the cluster's 64 sessions", async () => {
  const { start, latest } = await followed("forwardQueued");
  const forward = started(await start(SERVICE, 80));
  await vi.advanceTimersByTimeAsync(READY_AFTER_MS + 10_000);
  expect(latest(forward.id)).toMatchObject({
    state: { state: "ready" },
    connections: 66,
    queued: 2,
  });
  expect(latest(forward.id)?.sent).toBeGreaterThan(0);
});

test("forwardRestored starts prod-eu with a restored, a stopped and a failed forward", async () => {
  const { first, backend } = await followed("forwardRestored");
  expect(
    first.map(({ id, target, local, state }) => [
      id,
      target.space,
      target.name,
      local,
      state.state,
    ]),
  ).toEqual([
    [1, "prod-eu", "payments-api", 8081, "restored"],
    [2, "prod-eu", "payments-gateway", 9090, "stopped"],
    [3, "prod-eu", "payments-legacy", 8082, "failed"],
  ]);
  const failed = first[2]?.state;
  expect(failed).toEqual({
    state: "failed",
    error: {
      kind: "notFound",
      message: 'deployments.apps "payments-legacy" not found',
    },
  });
  expect(first[0]).toMatchObject({ pod: null, connections: 0 });

  await vi.advanceTimersByTimeAsync(FIRST_CONNECTION_AFTER_MS - 1);
  const again = await answered(
    backend.subscribe("forwards_watch", null, () => undefined),
  );
  expect(again.map(({ state }) => state.state)).toEqual([
    "restored",
    "stopped",
    "failed",
  ]);
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

test("a pod target's refusal names the pod, as the gate does for a request to it", async () => {
  const { backend, start } = await followed("forwardBlocked");
  started(await start(POD, 8080));
  await vi.advanceTimersByTimeAsync(READY_AFTER_MS + BLOCKED_AFTER_MS);
  const error = await refused(
    backend.invoke("forward_start", { target: POD, port: 8080, local: null }),
  );
  expect(error.message).toBe(
    `qa is read-only by qa in ${POLICY}, so Twigo did not send get pods/${pod.name}/portforward in ${pod.namespace}`,
  );
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

test("a stopped forward stays stopped through the refusal and its lifting", async () => {
  const { backend, start, latest } = await followed("forwardBlocked");
  const forward = started(await start(SERVICE, 80));
  const stopped = started(await start(GATEWAY, 80, 8099));
  await vi.advanceTimersByTimeAsync(READY_AFTER_MS);
  await answered(backend.invoke("forward_stop", stopped.id));
  await vi.advanceTimersByTimeAsync(
    BLOCKED_AFTER_MS + LIFTS_AFTER_MS + FIRST_CONNECTION_AFTER_MS,
  );
  expect(latest(forward.id)?.state.state).toBe("ready");
  expect(latest(stopped.id)).toMatchObject({ state: { state: "stopped" } });
});

const API: ForwardTarget = {
  space: "prod-eu",
  gvr: DEPLOYMENTS,
  namespace: "payments",
  name: "payments-api",
};
const LEGACY: ForwardTarget = { ...API, name: "payments-legacy" };
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

test("a stopped forward of an earlier run listens nowhere until it starts, and one stopped now keeps its addresses, as the core has them", async () => {
  const { backend, first, latest, start } = await followed("forwardRestored");
  expect(first.map(({ addresses }) => addresses)).toEqual([
    ["127.0.0.1", "::1"],
    [],
    ["127.0.0.1", "::1"],
  ]);
  await answered(backend.invoke("forward_resume", { id: 2, local: null }));
  expect(latest(2)?.addresses).toEqual(["127.0.0.1", "::1"]);

  await answered(backend.invoke("forward_stop", 2));
  expect(latest(2)).toMatchObject({
    state: { state: "stopped" },
    addresses: ["127.0.0.1", "::1"],
  });
  const fresh = started(await start(SERVICE, 80));
  expect(fresh.addresses).toEqual(["127.0.0.1", "::1"]);
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

test.each<[string, (backend: Backend) => Promise<unknown>, number[]]>([
  [
    "forward_ports",
    async (backend) => {
      const ports = await backend.invoke("forward_ports", API);
      expect(ports.ports[0]?.forward).toBe(1);
    },
    [1, 2, 3],
  ],
  [
    "forward_start",
    (backend) =>
      backend.invoke("forward_start", { target: API, port: 8080, local: null }),
    [1, 2, 3],
  ],
  [
    "forward_resume",
    (backend) => backend.invoke("forward_resume", { id: 2, local: null }),
    [1, 2, 3],
  ],
  ["forward_stop", (backend) => backend.invoke("forward_stop", 1), [1, 2, 3]],
  ["forward_remove", (backend) => backend.invoke("forward_remove", 3), [1, 2]],
])(
  "%s before the window follows the forwards finds the restored ones, and makes no second for a seeded port",
  async (_command, run, listed) => {
    const backend = createMockBackend("forwardRestored");
    await answered(backend.invoke("space_open", "prod-eu"));
    await answered(run(backend));
    const first = await answered(
      backend.subscribe("forwards_watch", null, () => undefined),
    );
    expect(first.map(({ id }) => id)).toEqual(listed);
  },
);

test("a start of a port whose forward's target is gone answers as a resume of it, and the forward fails again in words", async () => {
  const { start, latest } = await followed("forwardRestored");
  const answer = started(await start(LEGACY, 8080));
  expect(answer).toMatchObject({ id: 3, state: { state: "starting" } });
  await vi.advanceTimersByTimeAsync(READY_AFTER_MS);
  expect(latest(3)?.state).toMatchObject({
    state: "failed",
    error: { message: 'deployments.apps "payments-legacy" not found' },
  });
});

test("a start of a port with no forward, whose target is gone, is still refused", async () => {
  const { backend } = await followed("forwardRestored");
  const error = await refused(
    backend.invoke("forward_start", {
      target: LEGACY,
      port: 9999,
      local: null,
    }),
  );
  expect(error.kind).toBe("notFound");
});

test("starting on the free port that was offered is not remembered, and taking another port is", async () => {
  const { backend, start } = await followed("forwardBusy");
  const busy = await start(SERVICE, 80);
  expect(busy).toMatchObject({ outcome: "busy", free: 8081 });
  const detour = started(await start(SERVICE, 80, 8081));
  const held = await answered(backend.invoke("forward_ports", SERVICE));
  expect(held.ports[0]).toMatchObject({ local: 8081, forward: detour.id });
  await answered(backend.invoke("forward_remove", detour.id));
  const removed = await answered(backend.invoke("forward_ports", SERVICE));
  expect(removed.ports[0]).toMatchObject({ local: 80 + 8000, forward: null });

  const chosen = started(await start(SERVICE, 80, 8090));
  await answered(backend.invoke("forward_remove", chosen.id));
  const kept = await answered(backend.invoke("forward_ports", SERVICE));
  expect(kept.ports[0]).toMatchObject({ local: 8090 });
});

test("a move to the offered port is a detour too, and a stop and a resume keep it one", async () => {
  const { backend, start } = await followed("forwardBusy");
  const forward = started(await start(SERVICE, 80, 8085));
  const busy = await answered(
    backend.invoke("forward_resume", { id: forward.id, local: 8080 }),
  );
  expect(busy).toMatchObject({ outcome: "busy", free: 8081 });
  await answered(
    backend.invoke("forward_resume", { id: forward.id, local: 8081 }),
  );
  await answered(backend.invoke("forward_stop", forward.id));
  await answered(
    backend.invoke("forward_resume", { id: forward.id, local: null }),
  );
  await answered(backend.invoke("forward_remove", forward.id));
  const ports = await answered(backend.invoke("forward_ports", SERVICE));
  expect(ports.ports[0]).toMatchObject({ local: 8085 });
});
