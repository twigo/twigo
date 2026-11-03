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

const DAY = 86_400_000;

/** The nodes of a cluster with pods, which the pods spread over. */
const NODES = 40;

/** Deterministic pods and nodes for one context, so screenshots repeat. */
export class Cluster {
  readonly pods: Pod[] = [];
  readonly nodes: Node[] = [];
  /** Bumped on every change, so query results can be cached. */
  version = 0;
  /** When the cluster last changed, which the times its events print count from. */
  now: number;
  /** The kinds whose first subscription has synced; later ones start ready, as on a shared upstream. */
  readonly synced = new Set<string>();
  readonly #random: () => number;
  #serial = 0;

  constructor(
    readonly context: string,
    count: number,
    now: number,
  ) {
    this.now = now;
    this.#random = mulberry32(hash(context));
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
  return [
    pod.name,
    ...(withNamespace ? [pod.namespace] : []),
    `${pod.ready}/${pod.containers}`,
    pod.status,
    pod.restarts,
    null,
    pod.ip,
    pod.node,
    "<none>",
    "<none>",
  ];
}

/** The characters the API server appends to a `generateName`. */
const GENERATED_LENGTH = 5;

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
  if (!generateName || !name.startsWith(generateName)) return null;
  const suffix = name.slice(generateName.length);
  if (Array.from(suffix).length !== GENERATED_LENGTH) return null;
  const hash = labels["pod-template-hash"];
  return hash && generateName.endsWith(`-${hash}-`)
    ? generateName.length - hash.length - 1
    : generateName.length;
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

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
