import { IpcError } from "../error";
import type {
  Blocked,
  ContextAccess,
  Forward,
  ForwardEvent,
  ForwardId,
  ForwardPort,
  ForwardPorts,
  ForwardStarted,
  ForwardState,
  ForwardTarget,
  IpcError as WireError,
  ResumeForward,
  StartForward,
} from "../generated";
import { CLUSTER_SESSIONS } from "../shell";
import { setBy } from "./bus";
import type { Cluster } from "./cluster";
import { recordedManifest } from "./objects";

/**
 * Pins what the forwards do: `forwardBusy` holds the local port 8080 for
 * another process, `forwardReconnecting` has a ready forward lose its pod
 * and find another, `forwardFailed` fails every start, as nothing listens
 * on the pod's port, `forwardQueued` has connections wait for a session,
 * `forwardRestored` starts prod-eu with three forwards that an earlier run
 * left, and `forwardBlocked` has a policy file forbid forwards in the
 * context of the first forward that is ready, and lift that for good a
 * while later. Any other scenario starts none and lets every start through.
 */
export type ForwardScenario =
  | "forwardBusy"
  | "forwardReconnecting"
  | "forwardFailed"
  | "forwardQueued"
  | "forwardRestored"
  | "forwardBlocked";

export const FORWARD_SCENARIOS: readonly ForwardScenario[] = [
  "forwardBusy",
  "forwardReconnecting",
  "forwardFailed",
  "forwardQueued",
  "forwardRestored",
  "forwardBlocked",
];

export function isForwardScenario(
  scenario: string,
): scenario is ForwardScenario {
  return (FORWARD_SCENARIOS as readonly string[]).includes(scenario);
}

/** How long a start takes to be ready, or with `forwardFailed` to fail. */
export const READY_AFTER_MS = 400;
export const FAILS_AFTER_MS = 600;
/** After how long `forwardReconnecting` loses the pod, and for how long it waits for another. */
export const LOSES_POD_AFTER_MS = 8000;
export const RECONNECTS_FOR_MS = 5000;
/** After how long `forwardBlocked` forbids forwards, and for how long. */
export const BLOCKED_AFTER_MS = 8000;
export const LIFTS_AFTER_MS = 15_000;
/** After how long a forward that waits has its first connection, which proves it. */
export const FIRST_CONNECTION_AFTER_MS = 20_000;
const LIFE_MS = 1000;
const QUEUED = 2;
const BUSY_PORT = 8080;

const KINDS: Readonly<Record<string, { kind: string; fixture: string }>> = {
  "/v1/pods": { kind: "Pod", fixture: "pod" },
  "/v1/services": { kind: "Service", fixture: "service" },
  "apps/v1/deployments": { kind: "Deployment", fixture: "deployment" },
  "apps/v1/replicasets": { kind: "ReplicaSet", fixture: "replicaset" },
  "apps/v1/statefulsets": { kind: "StatefulSet", fixture: "statefulset" },
  "apps/v1/daemonsets": { kind: "DaemonSet", fixture: "daemonset" },
};

/** A port as the target declares it, and the port of the pod it reaches. */
interface Declared extends Omit<ForwardPort, "local" | "forward"> {
  readonly podPort: number;
}

/** The Services of the mock that end in `gateway` serve three ports; the recorded one serves one. */
const GATEWAY: readonly Declared[] = [
  {
    port: 9090,
    name: "metrics",
    targetPort: "metrics",
    container: null,
    appProtocol: "http",
    podPort: 9090,
  },
  {
    port: 80,
    name: "http",
    targetPort: "http",
    container: null,
    appProtocol: null,
    podPort: 8080,
  },
  {
    port: 9000,
    name: "grpc",
    targetPort: "grpc",
    container: null,
    appProtocol: "grpc",
    podPort: 50051,
  },
];

/** The containers of the Deployments that end in `gateway` declare three ports, those of the Services' targets. */
const GATEWAY_CONTAINER: readonly Declared[] = GATEWAY.map(
  ({ name, podPort }) => ({
    port: podPort,
    name,
    targetPort: null,
    container: "app",
    appProtocol: null,
    podPort,
  }),
);

interface Live {
  forward: Forward;
  /** The port of the pod it reaches. */
  readonly podPort: number;
  readonly timers: Set<ReturnType<typeof setTimeout>>;
  ticks: number;
}

/** What the forwards need of the rest of the mock backend. */
export interface ForwardHost {
  context(space: string): string | undefined;
  cluster(context: string): Cluster;
  /** A policy file makes the context read-only and forbids forwards in it, until it is lifted. */
  forbid(context: string): void;
  lift(context: string): void;
  access(context: string): ContextAccess;
}

interface Manifest {
  readonly spec: {
    readonly ports?: readonly {
      readonly port: number;
      readonly name?: string;
      readonly targetPort?: number | string;
      readonly appProtocol?: string;
    }[];
    readonly containers?: readonly Container[];
    readonly template?: { readonly spec: { readonly containers: Container[] } };
  };
}

interface Container {
  readonly name: string;
  readonly ports?: readonly {
    readonly containerPort: number;
    readonly name?: string;
    readonly protocol?: string;
  }[];
}

function fixture(name: string): Manifest {
  return recordedManifest(name) as unknown as Manifest;
}

function containerPorts(containers: readonly Container[]): Declared[] {
  return containers.flatMap((container) =>
    (container.ports ?? [])
      .filter((port) => (port.protocol ?? "TCP") === "TCP")
      .map((port) => ({
        port: port.containerPort,
        name: port.name ?? null,
        targetPort: null,
        container: container.name,
        appProtocol: null,
        podPort: port.containerPort,
      })),
  );
}

/** Ranks a port for the default: one named for HTTP first, metrics, health and debug last. */
function rank({ name }: Declared): number {
  if (name === null) return 1;
  if (/^(https?|web)\b/i.test(name)) return 0;
  return /metrics|health|debug/i.test(name) ? 2 : 1;
}

function descriptor(gvr: ForwardTarget["gvr"]): {
  kind: string;
  fixture: string;
} {
  const found = KINDS[`${gvr.group}/${gvr.version}/${gvr.resource}`];
  if (!found) {
    throw new IpcError(
      "invalidInput",
      `a port-forward reaches a pod, a Service, a Deployment, a ReplicaSet, a StatefulSet or a DaemonSet, not ${gvr.resource}`,
    );
  }
  return found;
}

function wire(error: IpcError): WireError {
  return {
    kind: error.kind,
    message: error.message,
    ...(error.blocked && { blocked: error.blocked }),
  };
}

function key(target: ForwardTarget, port: number): string {
  const { space, gvr, namespace, name } = target;
  return [space, gvr.group, gvr.resource, namespace, name, port].join("/");
}

/**
 * The port-forwards of the mock backend: kept by the core, as Rust keeps
 * them, for the life of the app and across windows, each passing `starting`
 * and then `ready` on a pod of its target while its counters move. A later
 * follower replaces an earlier one.
 */
export class MockForwards {
  readonly #lives = new Map<ForwardId, Live>();
  readonly #last = new Map<string, number>();
  readonly #forbidden = new Set<string>();
  #follower: ((event: ForwardEvent) => void) | undefined;
  #next = 1;
  #seeded = false;
  #policed = false;
  #life: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly scenario: ForwardScenario | undefined,
    private readonly host: ForwardHost,
  ) {}

  watch(onMessage: (event: ForwardEvent) => void): Forward[] {
    this.#seed();
    this.#follower = onMessage;
    return [...this.#lives.values()].map(({ forward }) => forward);
  }

  ports(target: ForwardTarget): ForwardPorts {
    const { kind, ports } = this.#declared(target);
    const [first] = [...ports].sort((a, b) => rank(a) - rank(b));
    return {
      kind,
      ports: ports.map(({ podPort: _, ...port }) => ({
        ...port,
        local: this.#localOf(target, port.port),
        forward: this.#find(target, port.port)?.forward.id ?? null,
      })),
      default: first?.port ?? 0,
    };
  }

  start({ target, port, local }: StartForward): ForwardStarted {
    this.#allow(target);
    const { kind, ports } = this.#declared(target);
    const declared = ports.find((candidate) => candidate.port === port);
    if (!declared) {
      throw new IpcError(
        "invalidInput",
        `${target.name} declares no port ${String(port)}`,
      );
    }
    const existing = this.#find(target, port);
    if (existing) return this.resume({ id: existing.forward.id, local });
    const wanted = local ?? this.#localOf(target, port);
    const busy = this.#busy(wanted);
    if (busy) return busy;
    const live = this.#add(target, kind, declared, wanted, {
      state: "starting",
    });
    this.#remember(live);
    this.#begin(live);
    return { outcome: "started", forward: live.forward };
  }

  stop(id: ForwardId): null {
    const live = this.#live(id);
    this.#clear(live);
    this.#set(live, {
      state: { state: "stopped" },
      pod: null,
      podPort: null,
      connections: 0,
      queued: 0,
      failure: null,
    });
    return null;
  }

  resume({ id, local }: ResumeForward): ForwardStarted {
    const live = this.#live(id);
    this.#allow(live.forward.target);
    const wanted = local ?? live.forward.local;
    const { state } = live.forward.state;
    const runs = state !== "stopped" && state !== "failed";
    if (runs && wanted === live.forward.local) {
      return { outcome: "started", forward: live.forward };
    }
    const busy = this.#busy(wanted, id);
    if (busy) return busy;
    if (runs) {
      this.#set(live, { local: wanted });
    } else {
      this.#clear(live);
      this.#begin(live, wanted);
    }
    this.#remember(live);
    return { outcome: "started", forward: live.forward };
  }

  remove(id: ForwardId): null {
    const live = this.#live(id);
    this.#clear(live);
    this.#lives.delete(id);
    this.#follower?.({ event: "removed", id });
    this.#unwind();
    return null;
  }

  #declared(target: ForwardTarget): { kind: string; ports: Declared[] } {
    const { kind, fixture: recorded } = descriptor(target.gvr);
    const context = this.#context(target.space);
    const { namespace, name } = target;
    const cluster = this.host.cluster(context);
    if (target.gvr.resource === "pods") {
      if (
        !cluster.pods.some(
          (pod) => pod.namespace === namespace && pod.name === name,
        )
      ) {
        throw new IpcError("notFound", `pods "${name}" not found`);
      }
    } else if (target.gvr.resource === "deployments") {
      if (
        cluster.podsOf(namespace, name).length === 0 &&
        !cluster.emptied.has(`${namespace}/${name}`)
      ) {
        throw new IpcError("notFound", `deployments.apps "${name}" not found`);
      }
    }
    const manifest = fixture(recorded);
    const gateway = name.endsWith("gateway");
    const ports =
      target.gvr.resource === "services"
        ? gateway
          ? [...GATEWAY]
          : servicePorts(manifest)
        : gateway && target.gvr.resource === "deployments"
          ? [...GATEWAY_CONTAINER]
          : containerPorts(
              manifest.spec.template?.spec.containers ??
                manifest.spec.containers ??
                [],
            );
    if (ports.length === 0) {
      throw new IpcError(
        "invalidInput",
        `${kind} ${name} declares no TCP port to forward`,
      );
    }
    return { kind, ports };
  }

  /** Refuses what the context's mode refuses, before anything is read or bound. */
  #allow(target: ForwardTarget): void {
    const context = this.#context(target.space);
    if (this.#forbidden.has(context)) throw this.#blocked(target, context);
  }

  #context(space: string): string {
    const context = this.host.context(space);
    if (context === undefined) {
      throw new IpcError("notFound", `no space ${space}`);
    }
    return context;
  }

  #live(id: ForwardId): Live {
    const live = this.#lives.get(id);
    if (!live) throw new IpcError("notFound", `no forward ${String(id)}`);
    return live;
  }

  #find(target: ForwardTarget, port: number): Live | undefined {
    const wanted = key(target, port);
    return [...this.#lives.values()].find(
      ({ forward }) => key(forward.target, forward.port) === wanted,
    );
  }

  #localOf(target: ForwardTarget, port: number): number {
    return (
      this.#last.get(key(target, port)) ?? (port < 1024 ? port + 8000 : port)
    );
  }

  #remember({ forward }: Live): void {
    this.#last.set(key(forward.target, forward.port), forward.local);
  }

  #taken(port: number, except?: ForwardId): boolean {
    if (this.scenario === "forwardBusy" && port === BUSY_PORT) return true;
    return [...this.#lives.values()].some(
      ({ forward }) =>
        forward.id !== except &&
        forward.state.state !== "stopped" &&
        forward.local === port,
    );
  }

  #busy(local: number, except?: ForwardId): ForwardStarted | undefined {
    const why =
      local < 1024
        ? ("notPermitted" as const)
        : this.#taken(local, except)
          ? ("inUse" as const)
          : undefined;
    if (!why) return undefined;
    let free = Math.max(local + 1, 1024);
    while (this.#taken(free, except)) free++;
    return { outcome: "busy", local, why, free };
  }

  #add(
    target: ForwardTarget,
    kind: string,
    declared: Declared,
    local: number,
    state: ForwardState,
  ): Live {
    const id = this.#next++;
    const live: Live = {
      podPort: declared.podPort,
      forward: {
        id,
        target,
        kind,
        port: declared.port,
        portName: declared.name,
        appProtocol: declared.appProtocol,
        local,
        addresses: ["127.0.0.1", "::1"],
        state,
        pod: null,
        podPort: null,
        connections: 0,
        queued: 0,
        sent: 0,
        received: 0,
        failure: null,
      },
      timers: new Set(),
      ticks: 0,
    };
    this.#lives.set(id, live);
    return live;
  }

  #set(live: Live, patch: Partial<Forward>): void {
    live.forward = { ...live.forward, ...patch };
    this.#follower?.({ event: "changed", forward: live.forward });
  }

  #later(live: Live, ms: number, run: () => void): void {
    const timer = setTimeout(() => {
      live.timers.delete(timer);
      run();
    }, ms);
    live.timers.add(timer);
  }

  #clear(live: Live): void {
    for (const timer of live.timers) clearTimeout(timer);
    live.timers.clear();
  }

  #begin(live: Live, local: number = live.forward.local): void {
    this.#set(live, {
      local,
      state: { state: "starting" },
      pod: null,
      podPort: null,
      connections: 0,
      queued: 0,
      failure: null,
    });
    this.#later(
      live,
      this.scenario === "forwardFailed" ? FAILS_AFTER_MS : READY_AFTER_MS,
      () => {
        this.#settle(live);
      },
    );
  }

  #settle(live: Live): void {
    const { target } = live.forward;
    const refusal = this.#missing(target) ?? this.#unreachable(live);
    if (refusal) {
      this.#set(live, {
        state: { state: "failed", error: wire(refusal) },
        pod: null,
        podPort: null,
      });
      return;
    }
    this.#ready(live, 0);
    if (this.scenario === "forwardReconnecting") {
      this.#later(live, LOSES_POD_AFTER_MS, () => {
        this.#lose(live);
      });
    }
    if (this.scenario === "forwardBlocked" && !this.#policed) {
      this.#policed = true;
      const context = this.#context(target.space);
      setTimeout(() => {
        this.#forbid(context);
      }, BLOCKED_AFTER_MS);
    }
  }

  #missing(target: ForwardTarget): IpcError | undefined {
    try {
      this.#declared(target);
    } catch (error) {
      if (error instanceof IpcError) return error;
      throw error;
    }
    return undefined;
  }

  #unreachable(live: Live): IpcError | undefined {
    if (this.scenario !== "forwardFailed") return undefined;
    const { pod, podPort } = this.#route(live, 0);
    return new IpcError(
      "unavailable",
      `pod ${pod} refused the connection to port ${String(podPort)}: nothing listens on it`,
    );
  }

  /** The gate's refusal of the request a connection sends, which names a pod only for a pod target. */
  #blocked(target: ForwardTarget, context: string): IpcError {
    const { source, mode } = this.host.access(context);
    const pod = target.gvr.resource === "pods" ? `/${target.name}` : "";
    const blocked: Blocked = {
      context,
      mode,
      source,
      class: "forward",
      reason: "mode",
      verb: "get",
      target: `pods${pod}/portforward in ${target.namespace}`,
    };
    return new IpcError(
      "permissions",
      `${context} is ${mode}${setBy(source)}, so Twigo did not send ${blocked.verb} ${blocked.target}`,
      blocked,
    );
  }

  #forbid(context: string): void {
    this.#forbidden.add(context);
    this.host.forbid(context);
    for (const live of this.#lives.values()) {
      const { target, state } = live.forward;
      if (this.host.context(target.space) !== context) continue;
      if (state.state === "stopped") continue;
      this.#clear(live);
      this.#set(live, {
        state: { state: "failed", error: wire(this.#blocked(target, context)) },
        pod: null,
        podPort: null,
        connections: 0,
        queued: 0,
      });
    }
    this.#unwind();
    setTimeout(() => {
      this.#lift(context);
    }, LIFTS_AFTER_MS);
  }

  /** What was refused in place waits for its first connection, whatever it was before. */
  #lift(context: string): void {
    this.#forbidden.delete(context);
    this.host.lift(context);
    for (const live of this.#lives.values()) {
      const { target, state } = live.forward;
      if (this.host.context(target.space) !== context) continue;
      if (state.state !== "failed" || !state.error.blocked) continue;
      this.#set(live, { state: { state: "restored" } });
      this.#awaitConnection(live);
    }
  }

  #awaitConnection(live: Live): void {
    this.#later(live, FIRST_CONNECTION_AFTER_MS, () => {
      this.#ready(live, 0);
    });
  }

  /** The pod new connections go to, the `n`th of the target's, and the port of it they reach. */
  #route(live: Live, n: number): { pod: string; podPort: number } {
    const { target } = live.forward;
    const { podPort } = live;
    if (target.gvr.resource === "pods") return { pod: target.name, podPort };
    const running = this.host
      .cluster(this.#context(target.space))
      .podsOf(target.namespace, target.name)
      .filter((pod) => pod.status === "Running")
      .map((pod) => pod.name);
    const pods = [
      ...running,
      `${target.name}-6d8b9c7f5-4tkzn`,
      `${target.name}-6d8b9c7f5-q8wxm`,
    ];
    return { pod: pods[n % pods.length] ?? target.name, podPort };
  }

  #ready(live: Live, n: number): void {
    const queued = this.scenario === "forwardQueued";
    this.#set(live, {
      state: { state: "ready" },
      ...this.#route(live, n),
      connections: queued ? CLUSTER_SESSIONS + QUEUED : 0,
      queued: queued ? QUEUED : 0,
      failure: null,
    });
    this.#life ??= setInterval(() => {
      this.#tick();
    }, LIFE_MS);
  }

  #lose(live: Live): void {
    if (live.forward.state.state !== "ready") return;
    const { pod } = live.forward;
    this.#set(live, {
      state: {
        state: "reconnecting",
        reason: `pod ${pod ?? ""} is gone; waiting for another ready pod`,
      },
      pod: null,
      podPort: null,
      connections: 0,
    });
    this.#later(live, RECONNECTS_FOR_MS, () => {
      this.#ready(live, 1);
    });
  }

  #tick(): void {
    for (const live of this.#lives.values()) {
      if (live.forward.state.state !== "ready") continue;
      live.ticks++;
      const { ticks } = live;
      const { connections } = live.forward;
      const queued = this.scenario === "forwardQueued";
      this.#set(live, {
        sent: live.forward.sent + 800 + ((ticks * 137) % 600),
        received: live.forward.received + 9000 + ((ticks * 4093) % 30_000),
        connections: queued
          ? connections
          : ticks % 6 === 1
            ? connections + 1
            : ticks % 6 === 4
              ? Math.max(0, connections - 1)
              : connections,
      });
    }
  }

  #unwind(): void {
    const ready = [...this.#lives.values()].some(
      ({ forward }) => forward.state.state === "ready",
    );
    if (ready || this.#life === undefined) return;
    clearInterval(this.#life);
    this.#life = undefined;
  }

  #seed(): void {
    if (this.#seeded || this.scenario !== "forwardRestored") return;
    this.#seeded = true;
    const space = "prod-eu";
    const at = (resource: string, group: string, name: string) => ({
      space,
      gvr: { group, version: "v1", resource },
      namespace: "payments",
      name,
    });
    const api = at("deployments", "apps", "payments-api");
    const gateway = at("services", "", "payments-gateway");
    const ghost = at("deployments", "apps", "payments-legacy");
    const named = (target: ForwardTarget, port: number) => {
      const { kind, ports } = this.#declared(target);
      const declared = ports.find((candidate) => candidate.port === port);
      if (!declared) throw new Error(`the mock has no port ${String(port)}`);
      return { kind, declared };
    };
    const restored = named(api, 8080);
    this.#awaitConnection(
      this.#add(api, restored.kind, restored.declared, 8081, {
        state: "restored",
      }),
    );
    const stopped = named(gateway, 9090);
    this.#add(gateway, stopped.kind, stopped.declared, 9090, {
      state: "stopped",
    });
    this.#add(
      ghost,
      "Deployment",
      {
        port: 8080,
        name: "http",
        targetPort: null,
        container: "app",
        appProtocol: null,
        podPort: 8080,
      },
      8082,
      {
        state: "failed",
        error: wire(
          new IpcError(
            "notFound",
            'deployments.apps "payments-legacy" not found',
          ),
        ),
      },
    );
  }
}

function servicePorts(manifest: Manifest): Declared[] {
  const template = fixture("deployment").spec.template?.spec.containers ?? [];
  const named = containerPorts(template);
  return (manifest.spec.ports ?? []).map((port) => {
    const target = port.targetPort ?? port.port;
    return {
      port: port.port,
      name: port.name ?? null,
      targetPort: target === port.port ? null : String(target),
      container: null,
      appProtocol: port.appProtocol ?? null,
      podPort:
        typeof target === "number"
          ? target
          : (named.find((candidate) => candidate.name === target)?.podPort ??
            port.port),
    };
  });
}
