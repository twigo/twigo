import { humanDuration } from "@twigo/utils";
import type { Cell, Column, Row } from "../generated";
import {
  generatedAt,
  hash,
  podCells,
  deploymentOf,
  replicaSetUid,
  type Cluster,
  type Pod,
} from "./cluster";
import {
  CRONJOB_COLUMNS,
  DEPLOYMENT_COLUMNS,
  EVENT_COLUMNS,
  JOB_COLUMNS,
  NODE_COLUMNS,
  POD_COLUMNS,
  VERSIONS,
} from "./fixtures";
import type { QueryRow } from "./query";

/**
 * A row as the mock serves it: what a query reads, where its name was
 * generated, and the fields a field selector reads, as the API server
 * selects by them.
 */
export interface MockRow extends QueryRow {
  readonly generated: number | null;
  readonly fields: Readonly<Record<string, string>>;
}

/** A kind the mock serves: the columns kube-apiserver sends for it, and its objects as rows. */
export interface MockKind {
  readonly columns: readonly Column[];
  /** The fields its rows can be selected by. */
  readonly fields: readonly string[];
  /** Old names of fields, as conversion maps them. */
  readonly aliases?: Readonly<Record<string, string>>;
  /** The cells follow `queryColumns(columns, query)`: Namespace second when the list shows it. */
  rows(cluster: Cluster, withNamespace: boolean): MockRow[];
}

/**
 * The kinds the mock serves, by `group/version/resource`. Nodes are those
 * the pods run on, Deployments those the pods' names say own them, and
 * events what the kubelet, the scheduler and the node controller report of
 * the pods' states, so the counts of one kind agree with the others.
 */
export const KINDS: Readonly<Record<string, MockKind>> = {
  "/v1/pods": {
    columns: POD_COLUMNS,
    fields: [
      "metadata.name",
      "metadata.namespace",
      "spec.nodeName",
      "spec.restartPolicy",
      "spec.schedulerName",
      "spec.serviceAccountName",
      "spec.hostNetwork",
      "status.phase",
      "status.podIP",
      "status.podIPs",
      "status.nominatedNodeName",
    ],
    aliases: { "spec.host": "spec.nodeName" },
    rows: (cluster, withNamespace) =>
      cluster.pods.map((pod) => ({
        id: pod.id,
        namespace: pod.namespace,
        created: pod.created,
        labels: {},
        controller: replicaSetUid(
          cluster.context,
          pod.namespace,
          deploymentOf(pod),
        ),
        cells: podCells(pod, withNamespace),
        generated: podGenerated(pod),
        fields: podFields(pod),
      })),
  },
  "/v1/nodes": {
    columns: NODE_COLUMNS,
    fields: ["metadata.name", "spec.unschedulable"],
    rows: (cluster) =>
      cluster.nodes.map((node) => ({
        id: node.id,
        namespace: null,
        created: node.created,
        labels: {},
        controller: null,
        cells: [
          node.name,
          node.status,
          "<none>",
          null,
          VERSIONS[cluster.context] ?? "",
          node.ip,
          "<none>",
          "Debian GNU/Linux 13 (trixie)",
          "6.12.54-cloud-amd64",
          "containerd://2.3.4",
        ],
        generated: null,
        fields: {
          "metadata.name": node.name,
          "spec.unschedulable": String(
            node.status.includes("SchedulingDisabled"),
          ),
        },
      })),
  },
  "apps/v1/deployments": {
    columns: DEPLOYMENT_COLUMNS,
    fields: ["metadata.name", "metadata.namespace"],
    rows: (cluster, withNamespace) =>
      deployments(cluster).map((deployment) => ({
        id: `${cluster.context}/${deployment.namespace}/${deployment.name}`,
        namespace: deployment.namespace,
        created: deployment.created,
        labels: { app: deployment.name },
        controller: null,
        cells: namespaced(
          [
            deployment.name,
            `${deployment.ready}/${deployment.replicas}`,
            deployment.replicas,
            deployment.ready,
            null,
            deployment.container,
            deployment.image,
            `app=${deployment.name}`,
          ],
          deployment.namespace,
          withNamespace,
        ),
        generated: null,
        fields: {
          "metadata.name": deployment.name,
          "metadata.namespace": deployment.namespace,
        },
      })),
  },
  "batch/v1/jobs": {
    columns: JOB_COLUMNS,
    fields: ["metadata.name", "metadata.namespace"],
    rows: (cluster, withNamespace) =>
      cluster.jobs.map((job) => {
        const status = job.suspend
          ? "Suspended"
          : job.completed === null
            ? "Running"
            : "Complete";
        return {
          id: job.id,
          namespace: job.namespace,
          created: job.created,
          labels: {},
          controller:
            job.owner && `${cluster.context}/${job.namespace}/${job.owner}`,
          cells: namespaced(
            [
              job.name,
              status,
              job.completed === null ? "0/1" : "1/1",
              humanDuration((job.completed ?? cluster.now) - job.created),
              null,
              "app",
              "registry.example.com/jobs/app:1.42.0",
              `batch.kubernetes.io/controller-uid=${job.id}`,
            ],
            job.namespace,
            withNamespace,
          ),
          generated: null,
          fields: {
            "metadata.name": job.name,
            "metadata.namespace": job.namespace,
          },
        };
      }),
  },
  "batch/v1/cronjobs": {
    columns: CRONJOB_COLUMNS,
    fields: ["metadata.name", "metadata.namespace"],
    rows: (cluster, withNamespace) =>
      cluster.cronJobs.map((cronJob) => ({
        id: cronJob.id,
        namespace: cronJob.namespace,
        created: cronJob.created,
        labels: {},
        controller: null,
        cells: namespaced(
          [
            cronJob.name,
            cronJob.schedule,
            "<none>",
            cronJob.suspend,
            cluster.jobs.filter(
              (job) =>
                job.namespace === cronJob.namespace &&
                job.owner === cronJob.name &&
                job.completed === null,
            ).length,
            humanDuration(cluster.now - cronJob.lastSchedule),
            null,
            "app",
            "registry.example.com/jobs/app:1.42.0",
            "<none>",
          ],
          cronJob.namespace,
          withNamespace,
        ),
        generated: null,
        fields: {
          "metadata.name": cronJob.name,
          "metadata.namespace": cronJob.namespace,
        },
      })),
  },
  "/v1/events": {
    columns: EVENT_COLUMNS,
    fields: ["metadata.name", "metadata.namespace"],
    rows: (cluster, withNamespace) =>
      events(cluster).map((event) => ({
        id: `${cluster.context}/${event.pod.namespace}/${event.name}`,
        namespace: event.pod.namespace,
        created: event.first,
        labels: {},
        controller: null,
        cells: namespaced(
          [
            humanDuration(cluster.now - event.last),
            event.type,
            event.reason,
            `pod/${event.pod.name}`,
            event.container ? `spec.containers{${containerOf(event.pod)}}` : "",
            event.source,
            event.message,
            humanDuration(cluster.now - event.first),
            event.count,
            event.name,
          ],
          event.pod.namespace,
          withNamespace,
        ),
        generated: null,
        fields: {
          "metadata.name": event.name,
          "metadata.namespace": event.pod.namespace,
        },
      })),
  },
};

/** Statuses of a pod whose containers have never run. */
const PENDING: ReadonlySet<string> = new Set([
  "Pending",
  "ContainerCreating",
  "ImagePullBackOff",
]);

/**
 * What a pod is selectable by, as kube-apiserver selects it (kubernetes
 * v1.37.1 `pkg/registry/core/pod/strategy.go` `ToSelectableFields`), read
 * from what the mock knows of it. Its pods restart always, so one whose
 * containers have run stays Running whatever they did, as the kubelet's
 * `getPhase` keeps it; a Pending one is not scheduled, so it has no node;
 * `status.podIPs`, which conversion accepts but the set lacks, is empty.
 */
function podFields(pod: Pod): Readonly<Record<string, string>> {
  const phase = PENDING.has(pod.status) ? "Pending" : "Running";
  return {
    "metadata.name": pod.name,
    "metadata.namespace": pod.namespace,
    "spec.nodeName": pod.status === "Pending" ? "" : pod.node,
    "spec.restartPolicy": "Always",
    "spec.schedulerName": "default-scheduler",
    "spec.serviceAccountName": "default",
    "spec.hostNetwork": "false",
    "status.phase": phase,
    "status.podIP": phase === "Pending" ? "" : pod.ip,
    "status.podIPs": "",
    "status.nominatedNodeName": "",
  };
}

export function wireRow(row: MockRow): Row {
  return {
    id: row.id,
    created: row.created === null ? null : new Date(row.created).toISOString(),
    generated: row.generated,
    cells: [...row.cells],
  };
}

function podGenerated(pod: Pod): number | null {
  return generatedAt(pod.name, pod.generateName, {
    "pod-template-hash": pod.templateHash,
  });
}

/** A namespaced kind's cells with Namespace second, as the query view adds it. */
function namespaced(
  [first, ...rest]: Cell[],
  namespace: string,
  withNamespace: boolean,
): Cell[] {
  return withNamespace
    ? [first ?? null, namespace, ...rest]
    : [first ?? null, ...rest];
}

/** Its Deployment's one container, named after the workload. */
function containerOf(pod: Pod): string {
  return deploymentOf(pod).slice(deploymentOf(pod).indexOf("-") + 1);
}

function imageOf(pod: Pod): string {
  return `registry.example.com/${pod.namespace}/${containerOf(pod)}:1.42.0`;
}

/** Ready as a Deployment counts its replicas: running with every container ready. */
function ready(pod: Pod): boolean {
  return pod.status === "Running" && pod.ready === pod.containers;
}

interface Deployment {
  readonly namespace: string;
  readonly name: string;
  readonly replicas: number;
  readonly ready: number;
  readonly created: number;
  readonly container: string;
  readonly image: string;
}

function deployments(cluster: Cluster): Deployment[] {
  const owned = new Map<string, Pod[]>();
  for (const pod of cluster.pods) {
    const key = `${pod.namespace}/${deploymentOf(pod)}`;
    const pods = owned.get(key);
    if (pods) pods.push(pod);
    else owned.set(key, [pod]);
  }
  const scaled = [...owned.values()].flatMap(([first, ...more]) => {
    if (!first) return [];
    const pods = [first, ...more];
    return [
      {
        namespace: first.namespace,
        name: deploymentOf(first),
        replicas: pods.length,
        ready: pods.filter(ready).length,
        created: Math.min(...pods.map((pod) => pod.created)),
        container: containerOf(first),
        image: imageOf(first),
      },
    ];
  });
  const emptied = [...cluster.emptied.values()].map((template) => ({
    namespace: template.namespace,
    name: deploymentOf(template),
    replicas: 0,
    ready: 0,
    created: template.created,
    container: containerOf(template),
    image: imageOf(template),
  }));
  return [...scaled, ...emptied];
}

interface Event {
  readonly pod: Pod;
  readonly name: string;
  readonly type: "Normal" | "Warning";
  readonly reason: string;
  /** Whether it is about the pod's container rather than the pod. */
  readonly container: boolean;
  readonly source: string;
  readonly message: string;
  readonly first: number;
  readonly last: number;
  readonly count: number;
}

/** An event as a pod's state reports it, before its object and times. */
type Reported = Omit<Event, "pod" | "name" | "first" | "last" | "count"> &
  Partial<Pick<Event, "count" | "last">>;

const HOUR = 3_600_000;

/**
 * What the pods' states make the cluster report, with the reasons and
 * messages a kind cluster of Kubernetes v1.37.0 recorded for them
 * (crates/twigo-cache/tests/fixtures/events-list.json), and the events of
 * an hour, the API server's default `--event-ttl`.
 */
function events(cluster: Cluster): Event[] {
  const notReady = new Set(
    cluster.nodes
      .filter((node) => node.status.startsWith("NotReady"))
      .map((node) => node.name),
  );
  const nodes = cluster.nodes.length;
  const since = cluster.now - HOUR;
  return cluster.pods.flatMap((pod) => {
    const kubelet = `kubelet, ${pod.node}`;
    const image = imageOf(pod);
    const reported: Reported[] = [];
    switch (pod.status) {
      case "CrashLoopBackOff":
      case "Error": {
        const [, count = "1", ago = "0"] =
          /^(\d+)(?: \((\d+)m ago\))?$/.exec(pod.restarts) ?? [];
        reported.push({
          type: "Warning",
          reason: "BackOff",
          container: true,
          source: kubelet,
          message: `Back-off restarting failed container ${containerOf(pod)} in pod ${pod.name}_${pod.namespace}(${uid(pod.id)})`,
          count: Math.max(1, Number(count)),
          last: cluster.now - Number(ago) * 60_000,
        });
        break;
      }
      case "ImagePullBackOff":
        reported.push(
          {
            type: "Warning",
            reason: "Failed",
            container: true,
            source: kubelet,
            message: `Failed to pull image "${image}": failed to pull and unpack image "${image}": failed to resolve reference "${image}": ${image}: not found`,
          },
          {
            type: "Normal",
            reason: "BackOff",
            container: true,
            source: kubelet,
            message: `Back-off pulling image "${image}"`,
          },
        );
        break;
      case "Pending":
        reported.push({
          type: "Warning",
          reason: "FailedScheduling",
          container: false,
          source: "default-scheduler",
          message: `0/${nodes} nodes are available: ${nodes} Insufficient memory. preemption: 0/${nodes} nodes are available: ${nodes} Preemption is not helpful for scheduling.`,
        });
        break;
      case "ContainerCreating":
        reported.push({
          type: "Normal",
          reason: "Pulling",
          container: true,
          source: kubelet,
          message: `Pulling image "${image}"`,
        });
        break;
    }
    if (pod.status !== "Pending" && notReady.has(pod.node)) {
      reported.push({
        type: "Warning",
        reason: "NodeNotReady",
        container: false,
        source: "node-controller",
        message: "Node is not ready",
      });
    }
    if (pod.status === "Running" && pod.created > since) {
      reported.push(
        {
          type: "Normal",
          reason: "Scheduled",
          container: false,
          source: "default-scheduler",
          message: `Successfully assigned ${pod.namespace}/${pod.name} to ${pod.node}`,
        },
        {
          type: "Normal",
          reason: "Started",
          container: true,
          source: kubelet,
          message: "Container started",
        },
      );
    }
    const first = Math.max(pod.created, since);
    return reported.map(({ count = 1, last, ...event }): Event => ({
      ...event,
      pod,
      name: `${pod.name}.${eventSuffix(pod.id, event.reason)}`,
      first,
      // A repeated event keeps its name and moves its last time, as the
      // recorded ones count up with Last Seen after First Seen.
      last:
        last ??
        Math.max(
          first,
          cluster.now - (hash(`${pod.id}/${event.reason}`) % 60) * 60_000,
        ),
      count,
    }));
  });
}

/** Sixteen hex digits after the object's name, as the recorded events are named. */
function eventSuffix(id: string, reason: string): string {
  return (
    hash(`${id}/${reason}`).toString(16).padStart(8, "0") +
    hash(`${reason}/${id}`).toString(16).padStart(8, "0")
  );
}

/** A uid in the shape the API server gives, stable for an id. */
function uid(id: string): string {
  const hex = [0, 1, 2, 3]
    .map((part) => hash(`${part}/${id}`).toString(16).padStart(8, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
