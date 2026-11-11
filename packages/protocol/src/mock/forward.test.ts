import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { IpcError } from "../error";
import type { Backend } from "../backend";
import type {
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

test("a running forward moves to another local port", async () => {
  const { backend, start, latest } = await followed();
  const forward = started(await start(SERVICE, 80));
  await vi.advanceTimersByTimeAsync(READY_AFTER_MS);
  await answered(
    backend.invoke("forward_resume", { id: forward.id, local: 8091 }),
  );
  expect(latest(forward.id)).toMatchObject({
    local: 8091,
    state: { state: "starting" },
  });
  await vi.advanceTimersByTimeAsync(READY_AFTER_MS);
  expect(latest(forward.id)?.state).toEqual({ state: "ready" });
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

  await vi.advanceTimersByTimeAsync(30_000);
  const again = await answered(
    backend.subscribe("forwards_watch", null, () => undefined),
  );
  expect(again.map(({ state }) => state.state)).toEqual([
    "restored",
    "stopped",
    "failed",
  ]);
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

test("forwardBlocked forbids forwards by a policy file 8 s after a forward is ready, and the forward says why", async () => {
  const { backend, start, latest } = await followed("forwardBlocked");
  const forward = started(await start(SERVICE, 80));
  await vi.advanceTimersByTimeAsync(READY_AFTER_MS + BLOCKED_AFTER_MS - 1);
  expect(latest(forward.id)?.state).toEqual({ state: "ready" });
  const routed = latest(forward.id)?.pod;
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
        source: {
          kind: "policyFile",
          file: "/Library/Application Support/Twigo/policy.json",
          pattern: "qa",
        },
      },
    },
  });
  if (state?.state !== "failed") throw new Error("not failed");
  expect(state.error.message).toBe(
    `qa is read-only by qa in /Library/Application Support/Twigo/policy.json, so Twigo did not send create pods/${routed ?? ""}/portforward in ${pod.namespace}`,
  );

  const contexts = await answered(
    backend.subscribe("contexts_watch", null, () => undefined),
  );
  expect(contexts.find(({ name }) => name === "qa")?.access).toMatchObject({
    mode: "read-only",
    source: { kind: "policyFile" },
  });
  const later = started(await start(GATEWAY, 80, 8099));
  await vi.advanceTimersByTimeAsync(READY_AFTER_MS);
  expect(latest(later.id)?.state).toMatchObject({
    state: "failed",
    error: { kind: "permissions" },
  });
});
