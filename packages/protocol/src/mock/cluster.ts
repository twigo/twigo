import type { Cell, RowId } from "../generated";
import { NAMESPACES, WORKLOADS } from "./fixtures";

export interface Pod {
  id: RowId;
  namespace: string;
  name: string;
  /** Its ReplicaSet's name and a dash. */
  generateName: string;
  /** Its ReplicaSet's `pod-template-hash`. */
  templateHash: string;
  containers: number;
  ready: number;
  status: string;
  restarts: string;
  created: number;
  ip: string;
  node: string;
  /** Bumped on every change; a subscription resends a row whose version moved. */
  version: number;
}

/**
 * The mock's uid of the ReplicaSet of a Deployment. The mock gives each
 * Deployment one ReplicaSet, whose pods differ in their hash alone, so a
 * pod that churn replaces stays the Deployment's.
 */
export function replicaSetUid(
  context: string,
  namespace: string,
  deployment: string,
): string {
  return `${context}/${namespace}/${deployment}`;
}

/** The Deployment a pod's name says owns it. */
export function deploymentOf(pod: Pod): string {
  return pod.generateName.slice(0, -(pod.templateHash.length + 2));
}

const ABNORMAL: [string, number][] = [
  ["Pending", 0.02],
  ["ContainerCreating", 0.01],
  ["CrashLoopBackOff", 0.015],
  ["Completed", 0.015],
  ["ImagePullBackOff", 0.005],
  ["Error", 0.005],
];

export interface Node {
  id: RowId;
  name: string;
  /** As kube-apiserver prints it: `Ready`, `NotReady`, `Ready,SchedulingDisabled`. */
  status: string;
  created: number;
  ip: string;
}

/** Whether a node is cordoned, as its status says. */
export function cordoned(node: Node): boolean {
  return node.status.endsWith(",SchedulingDisabled");
}

export interface CronJob {
  id: RowId;
  uid: string;
  namespace: string;
  name: string;
  schedule: string;
  suspend: boolean;
  lastSchedule: number;
  created: number;
}

export interface Job {
  id: RowId;
  namespace: string;
  name: string;
  /** The CronJob that made it. */
  owner: string | null;
  suspend: boolean;
  /** When it ran to completion; none while it runs. */
  completed: number | null;
  created: number;
}

/** What each CronJob of the mock does, by the namespaces it runs in. */
const CRON_JOBS: readonly (readonly [string, string, string])[] = [
  ["payments", "nightly-settlement", "0 2 * * *"],
  ["ledger", "reconcile", "*/30 * * * *"],
  ["notify", "digest", "0 8 * * 1-5"],
  ["batch", "report", "0 * * * *"],
  ["batch", "cleanup", "15 3 * * *"],
  ["monitoring", "prune-metrics", "0 4 * * 0"],
];

const DAY = 86_400_000;

/** The nodes of a cluster with pods, which the pods spread over. */
const NODES = 40;

/** Deterministic pods and nodes for one context, so screenshots repeat. */
export class Cluster {
  readonly pods: Pod[] = [];
  readonly nodes: Node[] = [];
  readonly cronJobs: CronJob[] = [];
  readonly jobs: Job[] = [];
  /**
   * Deployments scaled to zero, by `namespace/name`, each with a pod of its
   * template: the mock's Deployments are what their pods say, so these
   * keep their rows.
   */
  readonly emptied = new Map<string, Pod>();
  /** Bumped on every change, so query results can be cached. */
  version = 0;
  /** When the cluster last changed, which the times its events print count from. */
  now: number;
  /** The kinds whose first subscription has synced; later ones start ready, as on a shared upstream. */
  readonly synced = new Set<string>();
  readonly #random: () => number;
  /** Rollouts draw from a stream of their own, so the churn stays as it was. */
  readonly #rollouts: () => number;
  #serial = 0;

  constructor(
    readonly context: string,
    count: number,
    now: number,
  ) {
    this.now = now;
    this.#random = mulberry32(hash(context));
    this.#rollouts = mulberry32(hash(`${context}/rollouts`));
    for (let i = 0; i < count; i++) this.pods.push(this.#pod(now));
    // A stream of their own, so the pods and their churn stay as they were.
    const random = mulberry32(hash(`${context}/nodes`));
    for (let i = 0; i < (count > 0 ? NODES : 0); i++) {
      const name = `${context}-node-${i}`;
      const roll = random();
      this.nodes.push({
        id: `${context}/${name}`,
        name,
        status:
          roll < 0.05
            ? "NotReady"
            : roll < 0.08
              ? "Ready,SchedulingDisabled"
              : "Ready",
        created: now - Math.floor((30 + random() * 60) * DAY),
        ip: `10.0.${Math.floor(i / 200)}.${10 + (i % 200)}`,
      });
    }
    if (count === 0) return;
    for (const [namespace, name, schedule] of CRON_JOBS) {
      const created = now - Math.floor((10 + random() * 80) * DAY);
      const lastSchedule = now - Math.floor(random() * 3_600_000);
      this.cronJobs.push({
        id: `${context}/${namespace}/${name}`,
        uid: `${context}/${namespace}/${name}`,
        namespace,
        name,
        schedule,
        suspend: false,
        lastSchedule,
        created,
      });
      const job = `${name}-${String(Math.floor(lastSchedule / 60_000))}`;
      this.jobs.push({
        id: `${context}/${namespace}/${job}`,
        namespace,
        name: job,
        owner: name,
        suspend: false,
        completed: lastSchedule + Math.floor(5_000 + random() * 60_000),
        created: lastSchedule,
      });
    }
  }

  /** Changes `count` random pods plus every pod in `focus`, and replaces one pod. */
  churn(count: number, focus: Iterable<RowId>, now: number): void {
    const byId = new Map(this.pods.map((pod) => [pod.id, pod]));
    const targets = new Set<Pod>();
    for (const id of focus) {
      const pod = byId.get(id);
      if (pod && this.#random() < 0.08) targets.add(pod);
    }
    for (let i = 0; i < count; i++) {
      const pod = this.pods[Math.floor(this.#random() * this.pods.length)];
      if (pod) targets.add(pod);
    }
    for (const pod of targets) this.#change(pod);
    if (this.pods.length > 0) {
      const gone = Math.floor(this.#random() * this.pods.length);
      this.pods.splice(gone, 1, this.#pod(now, now));
    }
    this.now = now;
    this.version++;
  }

  /** Replaces a pod with a new one of its Deployment, as a rollout's step does. */
  rollOut(pod: Pod, now: number): void {
    const random = this.#rollouts;
    const templateHash = Math.floor(random() * 0xffffffff)
      .toString(36)
      .slice(0, 8);
    const suffix = Math.floor(random() * 36 ** 5)
      .toString(36)
      .padStart(5, "0");
    const generateName = `${deploymentOf(pod)}-${templateHash}-`;
    const name = `${generateName}${suffix}`;
    const next: Pod = {
      ...pod,
      id: `${this.context}/${pod.namespace}/${name}`,
      name,
      generateName,
      templateHash,
      status: "Running",
      ready: pod.containers,
      restarts: "0",
      created: now,
      version: 0,
    };
    this.pods.splice(this.pods.indexOf(pod), 1, next);
    this.now = now;
    this.version++;
  }

  /** Deletes a pod, which its ReplicaSet replaces with a new one, as it does a pod that goes. */
  deletePod(pod: Pod, now: number): void {
    const suffix = Math.floor(this.#rollouts() * 36 ** 5)
      .toString(36)
      .padStart(5, "0");
    const name = `${pod.generateName}${suffix}`;
    const next: Pod = {
      ...pod,
      id: `${this.context}/${pod.namespace}/${name}`,
      name,
      status: "ContainerCreating",
      ready: 0,
      restarts: "0",
      created: now,
      version: 0,
    };
    this.pods.splice(this.pods.indexOf(pod), 1, next);
    this.now = now;
    this.version++;
  }

  /** Deletes a node; its pods stay, as the API server keeps them. */
  deleteNode(name: string): void {
    const index = this.nodes.findIndex((node) => node.name === name);
    if (index >= 0) this.nodes.splice(index, 1);
    this.version++;
  }

  /** Deletes a Deployment, and its pods with it, as the garbage collector does. */
  deleteDeployment(namespace: string, name: string): void {
    const kept = this.pods.filter(
      (pod) => pod.namespace !== namespace || deploymentOf(pod) !== name,
    );
    this.pods.splice(0, this.pods.length, ...kept);
    this.version++;
  }

  /** The pods of a Deployment, as their names say. */
  podsOf(namespace: string, deployment: string): Pod[] {
    return this.pods.filter(
      (pod) => pod.namespace === namespace && deploymentOf(pod) === deployment,
    );
  }

  /** Sets a Deployment's replicas: new pods start, or the newest go. */
  scale(
    namespace: string,
    deployment: string,
    replicas: number,
    now: number,
  ): void {
    const key = `${namespace}/${deployment}`;
    const pods = this.podsOf(namespace, deployment);
    const template = pods[0] ?? this.emptied.get(key);
    if (!template) return;
    for (let i = pods.length; i < replicas; i++) {
      const suffix = Math.floor(this.#rollouts() * 36 ** 5)
        .toString(36)
        .padStart(5, "0");
      const name = `${template.generateName}${suffix}`;
      this.pods.push({
        ...template,
        id: `${this.context}/${namespace}/${name}`,
        name,
        status: "ContainerCreating",
        ready: 0,
        restarts: "0",
        created: now,
        node: `${this.context}-node-${Math.floor(this.#rollouts() * this.nodes.length)}`,
        version: 0,
      });
    }
    const going = [...pods]
      .sort((a, b) => b.created - a.created)
      .slice(0, Math.max(0, pods.length - replicas));
    for (const pod of going) this.pods.splice(this.pods.indexOf(pod), 1);
    if (replicas === 0) this.emptied.set(key, template);
    else this.emptied.delete(key);
    this.now = now;
    this.version++;
  }

  /** Replaces each of a Deployment's pods, as a rollout of a new template does. */
  restart(namespace: string, deployment: string, now: number): void {
    for (const pod of this.podsOf(namespace, deployment))
      this.rollOut(pod, now);
  }

  /** Marks a node unschedulable, or schedulable again. */
  cordon(name: string, unschedulable: boolean): void {
    const node = this.nodes.find((candidate) => candidate.name === name);
    if (!node) return;
    const status = node.status.replace(",SchedulingDisabled", "");
    node.status = unschedulable ? `${status},SchedulingDisabled` : status;
    this.version++;
  }

  /** Cordons a node and moves its pods to others, as their controllers replace them. */
  drain(name: string, now: number): void {
    this.cordon(name, true);
    const others = this.nodes.filter(
      (node) => node.name !== name && !cordoned(node),
    );
    for (const pod of this.pods.filter(
      (candidate) => candidate.node === name,
    )) {
      const node = others[Math.floor(this.#rollouts() * others.length)];
      const index = this.pods.indexOf(pod);
      this.deletePod(pod, now);
      const next = this.pods[index];
      if (next && node) next.node = node.name;
    }
    this.now = now;
    this.version++;
  }

  /** Runs a CronJob's template now as a Job of `name`. */
  trigger(namespace: string, cronJob: string, name: string, now: number): void {
    this.jobs.push({
      id: `${this.context}/${namespace}/${name}`,
      namespace,
      name,
      owner: cronJob,
      suspend: false,
      completed: null,
      created: now,
    });
    this.now = now;
    this.version++;
  }

  /** Suspends a Job or a CronJob, or resumes it. */
  suspend(of: CronJob | Job, suspend: boolean): void {
    of.suspend = suspend;
    this.version++;
  }

  /** Changes `count` distinct random pods. */
  change(count: number): void {
    const picked = new Set<Pod>();
    while (picked.size < Math.min(count, this.pods.length)) {
      const pod = this.pods[Math.floor(this.#random() * this.pods.length)];
      if (pod) picked.add(pod);
    }
    for (const pod of picked) this.#change(pod);
    this.version++;
  }

  #change(pod: Pod): void {
    const roll = this.#random();
    if (roll < 0.5) {
      const count = Number.parseInt(pod.restarts, 10) + 1;
      pod.restarts = `${count} (${Math.ceil(this.#random() * 50)}s ago)`;
    } else if (roll < 0.8) {
      pod.status = pod.status === "Running" ? "CrashLoopBackOff" : "Running";
      pod.ready = pod.status === "Running" ? pod.containers : 0;
    } else {
      pod.ready = pod.ready === pod.containers ? pod.ready - 1 : pod.containers;
    }
    pod.version++;
  }

  #pod(now: number, created?: number): Pod {
    const random = this.#random;
    const namespace = pick(NAMESPACES, random);
    const workload = pick(WORKLOADS, random);
    const templateHash = Math.floor(random() * 0xffffffff)
      .toString(36)
      .slice(0, 8);
    const suffix = Math.floor(random() * 36 ** 5)
      .toString(36)
      .padStart(5, "0");
    const generateName = `${namespace.split("-")[0] ?? namespace}-${workload}-${templateHash}-`;
    const name = `${generateName}${suffix}`;
    const containers = 1 + Math.floor(random() * random() * 3);
    let status = "Running";
    let roll = random();
    for (const [abnormal, share] of ABNORMAL) {
      if (roll < share) {
        status = abnormal;
        break;
      }
      roll -= share;
    }
    const restarts =
      status === "CrashLoopBackOff"
        ? 5 + Math.floor(random() * 40)
        : random() < 0.8
          ? 0
          : 1 + Math.floor(random() * 4);
    this.#serial++;
    return {
      id: `${this.context}/${namespace}/${name}`,
      namespace,
      name,
      generateName,
      templateHash,
      containers,
      ready:
        status === "Running"
          ? containers
          : status === "CrashLoopBackOff"
            ? containers - 1
            : 0,
      status,
      restarts:
        restarts === 0
          ? "0"
          : `${restarts} (${1 + Math.floor(random() * 59)}m ago)`,
      created: created ?? now - Math.floor(random() * random() * 90 * DAY),
      ip: `10.244.${this.#serial % 250}.${1 + Math.floor(random() * 250)}`,
      node: `${this.context}-node-${Math.floor(random() * NODES)}`,
      version: 0,
    };
  }
}

/** The cells of a pod, matching `queryColumns(POD_COLUMNS, query)`. */
export function podCells(pod: Pod, withNamespace: boolean): Cell[] {
  const scheduled = pod.status !== "Pending";
  return [
    pod.name,
    ...(withNamespace ? [pod.namespace] : []),
    `${pod.ready}/${pod.containers}`,
    pod.status,
    pod.restarts,
    null,
    scheduled ? pod.ip : "<none>",
    scheduled ? pod.node : "<none>",
    "<none>",
    "<none>",
  ];
}

/** The characters the API server appends to a `generateName`. */
const GENERATED_LENGTH = 5;
const KEPT_BASE = 58;

/**
 * Where the generated part of a name starts, as Rust's row metadata finds
 * it: after `generateName` when the API server appended its characters to
 * it, or at the `pod-template-hash` that ends `generateName`.
 */
export function generatedAt(
  name: string,
  generateName: string | null,
  labels: Readonly<Record<string, string>>,
): number | null {
  if (!generateName) return null;
  if (labels["statefulset.kubernetes.io/pod-name"] === name) return null;
  const kept = keptBase(generateName);
  if (kept === null || !name.startsWith(kept)) return null;
  const suffix = name.slice(kept.length);
  if (Array.from(suffix).length !== GENERATED_LENGTH) return null;
  const hash = labels["pod-template-hash"];
  return hash && generateName.endsWith(`-${hash}-`)
    ? Math.min(kept.length, generateName.length - hash.length - 1)
    : kept.length;
}

/** What the API server keeps of a generateName: its first 58 bytes, none if they end inside a character. */
function keptBase(base: string): string | null {
  let bytes = 0;
  let end = 0;
  for (const char of base) {
    const code = char.codePointAt(0) ?? 0;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > KEPT_BASE)
      return bytes === KEPT_BASE ? base.slice(0, end) : null;
    bytes += size;
    end += char.length;
  }
  return base;
}

function pick<T>(items: readonly T[], random: () => number): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error("pick needs a non-empty list");
  return item;
}

/** FNV-1a, for seeds and names that stay the same for the same text. */
export function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
