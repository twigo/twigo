import type {
  Block,
  Finding,
  Header,
  ObjectQuery,
  Overview,
  Value,
  Vital,
} from "../generated";
import {
  CONTAINER_START,
  cordoned,
  deploymentOf,
  finishedAt,
  hash,
  podCells,
  restartCount,
  type Cluster,
  type Node,
  type Pod,
} from "./cluster";
import { DEPLOYMENT_COLUMNS, NODE_COLUMNS, POD_COLUMNS } from "./fixtures";
import {
  deploymentCells,
  deployments,
  nodeCells,
  podGenerated,
  type Deployment,
} from "./kinds";
import { cronJobPage, jobPage } from "./jobs";
import { reported, stated, starting, titleOf } from "./pods";
import {
  ago,
  amended,
  counted,
  created,
  diagnosed,
  failing,
  fieldText,
  printed,
  printedCell,
  restated,
  swapped,
  text,
  toned,
  withFields,
  words,
} from "./sections";

/** What the core allocates to pods on a node of the mock, as the recorded node does. */
const NODE_PODS = 110;

const MINUTE = 60_000;

/** Whether a mock pod's container keeps crashing or failed, which is what its restarts led to. */
function crashes(pod: Pod): boolean {
  return pod.status === "CrashLoopBackOff" || pod.status === "Error";
}

/** What the mock pod's list row says: its owner, node, printed cells, and what its own state makes the header say. */
function podHeader(recorded: Overview, pod: Pod): Header {
  const title = titleOf(recorded);
  const restarts = restartCount(pod);
  const ready = `${String(pod.ready)}/${String(pod.containers)}`;
  const finished = pod.status === "Completed";
  const ended = finishedAt(pod);
  const last = pod.lastRestart;
  const sentence =
    title ??
    (finished
      ? [...words("Finished "), ago(ended)]
      : restarts === 0
        ? words(`${ready} ready · no restarts`)
        : [
            ...words(
              `${ready} ready · ${counted(restarts, "restart")}${last === null ? "" : ", last "}`,
            ),
            ...(last === null ? [] : [ago(last)]),
          ]);
  return {
    owner: {
      group: "apps",
      version: "v1",
      kind: "Deployment",
      namespace: pod.namespace,
      name: deploymentOf(pod),
    },
    node: pod.status === "Pending" ? null : pod.node,
    created: recorded.header.created,
    generated: podGenerated(pod),
    printed: printed(POD_COLUMNS, podCells(pod, false)),
    sentence,
    vitals: [
      {
        label: "Ready",
        value:
          pod.ready < pod.containers && !finished ? toned(ready) : text(ready),
        note: [],
      },
      {
        label: "Restarts",
        value:
          restarts > 0 && crashes(pod)
            ? toned(String(restarts))
            : text(String(restarts)),
        note: restarts > 0 && last !== null ? [ago(last)] : [],
      },
    ],
  };
}

/** The conditions that follow from what a pod's containers do. */
const READINESS = ["PodReadyToStartContainers", "ContainersReady", "Ready"];

/** A pod that completed: its readiness and its initialization are states, as the core sends them once it has finished. */
function completed(page: Overview, pod: Pod): Overview {
  const ended = new Date(finishedAt(pod)).toISOString();
  const initialized = new Date(pod.created + CONTAINER_START).toISOString();
  return restated(
    page,
    (condition) =>
      READINESS.includes(condition.type) || condition.type === "Initialized"
        ? {
            ...condition,
            status: condition.type === "Initialized" ? "True" : "False",
            tone: "neutral",
            reason: "PodCompleted",
            message: null,
            lastTransition:
              condition.type === "Initialized" ? initialized : ended,
            explained: false,
          }
        : condition,
    null,
  );
}

/** The mock pod's own node and addresses where the recorded pod's stand, and no host address where its node is gone. */
function placed(
  recorded: Overview,
  pod: Pod,
  cluster: Cluster | undefined,
): Overview {
  const node = recorded.header.node;
  if (node === null) return recorded;
  const host = cluster?.nodes.find((candidate) => candidate.name === pod.node);
  const pairs = new Map<string, string>([[node, pod.node]]);
  const pods = fieldText(recorded, "Pod IP");
  if (pods !== undefined) pairs.set(pods, pod.ip);
  const hosts = fieldText(recorded, "Host IP");
  if (hosts !== undefined && host) pairs.set(hosts, host.ip);
  const page = swapped(recorded, pairs, new Map());
  return host
    ? page
    : amended(page, "core.placement", (section) =>
        withFields(section, (fields) =>
          fields.filter((field) => field.label !== "Host IP"),
        ),
      );
}

function podPage(
  recorded: Overview,
  pod: Pod,
  cluster: Cluster | undefined,
): Overview {
  const placement = stated(placed(recorded, pod, cluster), pod);
  const page = created(
    { ...placement, header: podHeader(placement, pod) },
    pod.created,
  );
  const started = amended(page, "core.metadata", (section) =>
    withFields(section, (fields) =>
      fields.map((field) =>
        field.label === "Started"
          ? {
              ...field,
              value: {
                type: "time",
                at: new Date(pod.created + CONTAINER_START).toISOString(),
              },
            }
          : field,
      ),
    ),
  );
  const events = reported(started, pod);
  switch (pod.status) {
    case "Completed":
      return completed(events, pod);
    case "ContainerCreating":
      return starting(events, pod);
    default:
      return events;
  }
}

/**
 * The fewest pods a Deployment keeps available: the API server defaults its
 * max unavailable to 25 %, rounded down, and its controller sets Available
 * False below what that leaves
 * (https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/apis/apps/v1/defaults.go#L54-L58,
 * https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/controller/deployment/sync.go#L523).
 */
function minAvailable(replicas: number): number {
  return replicas - Math.floor(replicas / 4);
}

/** When its newest pod that is not ready began, if fewer pods are available than a Deployment keeps. */
function unavailableSince(
  deployment: Deployment,
  cluster: Cluster,
): number | null {
  if (deployment.ready >= minAvailable(deployment.replicas)) return null;
  return Math.max(
    ...cluster.pods
      .filter(
        (pod) =>
          pod.namespace === deployment.namespace &&
          deploymentOf(pod) === deployment.name &&
          !(pod.status === "Running" && pod.ready === pod.containers),
      )
      .map((pod) => pod.created),
  );
}

function unavailable(deployment: Deployment, since: number): Finding {
  const { replicas, ready } = deployment;
  return {
    tone: "warning",
    title: "Fewer pods are available than it needs",
    detail: [
      ...words(`${String(ready)} of ${String(replicas)} pods are available`),
      ...words(", since "),
      ago(since),
      ...words("."),
    ],
    message: "Deployment does not have minimum availability.",
    logs: null,
  };
}

/** The ReplicaSets that a recorded Deployment's history lists, newest first. */
function recordedSets(recorded: Overview): string[] {
  return recorded.sections
    .filter((section) => section.id === "core.rollout")
    .flatMap((section) => section.blocks)
    .flatMap((block) => (block.type === "table" ? block.rows : []))
    .flatMap(([, set]) => (set?.type === "link" ? [set.target.name] : []));
}

/** The Deployment the mock's pods make: what its row counts, its own ReplicaSets and image, and the Available finding if its pods fall short. */
function deploymentPage(
  recorded: Overview,
  deployment: Deployment,
  cluster: Cluster,
): Overview {
  const { replicas, ready } = deployment;
  const since = unavailableSince(deployment, cluster);
  const finding = since === null ? null : unavailable(deployment, since);
  const revision = recorded.header.vitals.find(
    (vital) => vital.label === "Revision",
  );
  const tag = deployment.image.split(":").pop() ?? "";
  const shown = `${String(ready)}/${String(replicas)}`;
  const vitals: Vital[] = [
    {
      label: "Ready",
      value: ready < replicas ? toned(shown) : text(shown),
      note: [],
    },
    {
      label: "Updated",
      value: text(`${String(replicas)}/${String(replicas)}`),
      note: [],
    },
    ...(revision ? [{ ...revision, note: words(tag) }] : []),
  ];
  const number = revision?.value.type === "text" ? revision.value.text : null;
  const header: Header = {
    owner: null,
    node: null,
    created: recorded.header.created,
    generated: null,
    printed: printed(DEPLOYMENT_COLUMNS, deploymentCells(deployment, false)),
    sentence: finding
      ? words(finding.title)
      : [
          ...words(
            `${shown} ready${number === null ? "" : ` · revision ${number}, `}`,
          ),
          ...(number === null ? [] : [ago(deployment.firstPod)]),
        ],
    vitals,
  };
  const set = `${deployment.name}-${deployment.templateHash}`;
  const older = `${deployment.name}-${hash(set).toString(36)}`;
  const made = new Date(deployment.created).toISOString();
  const rolled = new Date(deployment.firstPod).toISOString();
  const replicaSet = (name: string, shownText: string): Value => ({
    type: "link",
    target: {
      group: "apps",
      version: "v1",
      kind: "ReplicaSet",
      namespace: deployment.namespace,
      name,
    },
    text: shownText,
  });
  const history = (
    revisionNumber: number,
    name: string,
    counts: string,
    at: string,
  ) => [
    text(String(revisionNumber)),
    replicaSet(name, name),
    { type: "code" as const, text: deployment.image },
    text(counts),
    { type: "time" as const, at },
  ];
  const [recordedNew, recordedOld] = recordedSets(recorded);
  const recordedImage = printedCell(recorded, "Images");
  const recordedSelector = printedCell(recorded, "Selector");
  const pairs = new Map<string, string>();
  if (recordedNew !== undefined) pairs.set(recordedNew, set);
  if (recordedOld !== undefined) pairs.set(recordedOld, older);
  if (recordedImage !== undefined) {
    pairs.set(recordedImage, deployment.image);
    pairs.set(
      recordedImage.split("/").pop() ?? recordedImage,
      deployment.image.split("/").pop() ?? deployment.image,
    );
  }
  if (recordedSelector !== undefined) {
    pairs.set(recordedSelector, `app=${deployment.name}`);
  }
  const whole = new Map<string, string>();
  const recordedApp = recordedSelector?.split("=")[1];
  if (recordedApp !== undefined) whole.set(recordedApp, deployment.name);
  let page = created(
    { ...swapped(recorded, pairs, whole), header },
    deployment.created,
  );
  const counts = `${String(replicas)} desired | ${String(replicas)} updated | ${String(replicas)} total | ${String(ready)} available | ${String(replicas - ready)} unavailable`;
  page = amended(page, "core.rollout", (section) => ({
    ...section,
    blocks: section.blocks.map((block): Block => {
      if (block.type === "fields") {
        return {
          ...block,
          fields: block.fields.map((field) =>
            field.label === "Replicas"
              ? { ...field, value: text(counts) }
              : field.label === "New ReplicaSet"
                ? {
                    ...field,
                    value: replicaSet(
                      set,
                      `${set} (${String(replicas)}/${String(replicas)} replicas created)`,
                    ),
                  }
                : field,
          ),
        };
      }
      const last = Number.parseInt(number ?? "", 10);
      return block.type === "table" && !Number.isNaN(last)
        ? {
            ...block,
            rows: [
              history(last, set, shown, rolled),
              ...(last > 1 ? [history(last - 1, older, "0/0", made)] : []),
            ],
          }
        : block;
    }),
    summary:
      number === null
        ? []
        : [...words(`revision ${number}, `), ago(deployment.firstPod)],
    tone: null,
  }));
  page = amended(page, "core.pods", (section) => ({
    ...section,
    summary: finding ? words(finding.title) : words(`${shown} ready`),
    tone: finding ? "warning" : null,
  }));
  page = amended(page, "core.template", (section) => ({
    ...section,
    blocks: section.blocks.map((block) =>
      block.type === "containers"
        ? {
            ...block,
            containers: block.containers.map((card) => ({
              ...card,
              name: deployment.container,
            })),
          }
        : block,
    ),
  }));
  page = amended(page, "core.strategy", (section) => {
    const [update] = section.summary.flatMap((span) =>
      span.type === "text" ? [span.text.split(" · ")[0] ?? ""] : [],
    );
    return {
      ...section,
      summary: words(`${update ?? ""} · ${counted(replicas, "replica")}`),
    };
  });
  page = restated(
    page,
    (condition) => {
      if (condition.type === "Available" && finding && since !== null) {
        return failing(
          condition,
          "MinimumReplicasUnavailable",
          "Deployment does not have minimum availability.",
          since,
        );
      }
      return condition.type === "Available" || condition.type === "Progressing"
        ? { ...condition, lastTransition: made }
        : condition;
    },
    finding ? "warning" : undefined,
  );
  return diagnosed(page, finding ? [finding] : []);
}

/** The node the mock's pods run on: its status word, the findings its state makes, and the pods that run on it. */
function nodePage(recorded: Overview, node: Node, cluster: Cluster): Overview {
  const running = cluster.pods.filter(
    (pod) =>
      pod.node === node.name &&
      pod.status !== "Pending" &&
      pod.status !== "Completed",
  ).length;
  const notReady = node.status.startsWith("NotReady");
  const since = cluster.built - (5 + (hash(node.id) % 50)) * MINUTE;
  const findings: Finding[] = [
    ...(notReady
      ? [
          {
            tone: "danger" as const,
            title: "The node is not ready",
            detail: [...words("Since "), ago(since), ...words(".")],
            message:
              "container runtime network not ready: NetworkReady=false reason:NetworkPluginNotReady message:Network plugin returns error: cni plugin not initialized",
            logs: null,
          },
        ]
      : []),
    ...(cordoned(node)
      ? [
          {
            tone: "warning" as const,
            title: "The node is cordoned",
            detail: words("New pods are not scheduled on it."),
            message: null,
            logs: null,
          },
        ]
      : []),
  ];
  const requested = recorded.header.vitals.filter((vital) =>
    vital.label.endsWith("requested"),
  );
  const kubelet = String(nodeCells(node, cluster.context)[4] ?? "");
  const header: Header = {
    owner: null,
    node: null,
    created: recorded.header.created,
    generated: null,
    printed: printed(NODE_COLUMNS, nodeCells(node, cluster.context)),
    sentence: findings[0]
      ? words(findings[0].title)
      : words(`Schedulable · ${String(running)}/${String(NODE_PODS)} pods`),
    vitals: [
      {
        label: "Pods",
        value: text(`${String(running)}/${String(NODE_PODS)}`),
        note: [],
      },
      ...requested,
      { label: "Kubelet", value: text(kubelet), note: [] },
    ],
  };
  let page = created({ ...recorded, header }, node.created);
  page = amended(page, "core.resources", (section) => ({
    ...section,
    blocks: section.blocks.map((block) =>
      block.type !== "table"
        ? block
        : {
            ...block,
            rows: block.rows.map((row) =>
              row[0]?.type === "text" && row[0].text === "pods"
                ? row.map((cell, index) =>
                    index === 3 ? text(String(running)) : cell,
                  )
                : row,
            ),
          },
    ),
  }));
  if (notReady) {
    page = restated(
      page,
      (condition) =>
        condition.type === "Ready"
          ? failing(
              condition,
              "KubeletNotReady",
              findings[0]?.message ?? "",
              since,
            )
          : condition,
      "warning",
    );
  }
  page = amended(page, "core.pods", (section) => ({
    ...section,
    summary: words(`${String(running)}/${String(NODE_PODS)} pods`),
  }));
  if (cordoned(node)) {
    page = amended(page, "core.taints", (section) => ({
      ...withFields(section, (fields) =>
        fields.flatMap((field) =>
          field.label === "Roles"
            ? [
                field,
                {
                  label: "Unschedulable",
                  value: toned("true"),
                  default: false,
                },
              ]
            : [field],
        ),
      ),
      summary: words("The node is cordoned"),
      tone: "warning",
    }));
  }
  page = amended(page, "core.system", (section) => ({
    ...withFields(section, (fields) =>
      fields.map((field) =>
        field.label === "Kubelet" ? { ...field, value: text(kubelet) } : field,
      ),
    ),
    summary: words(`kubelet ${kubelet}`),
  }));
  return diagnosed(page, findings);
}

/**
 * The recorded document for the mock's object: the header, and what the
 * page says of what the list's row for it prints, so the two never
 * disagree, and what the object's own state makes its sentence, vitals and
 * sections say.
 */
export function headed(
  overview: Overview,
  query: ObjectQuery,
  cluster: Cluster | undefined,
  subject: { pod: Pod } | { node: Node } | undefined,
): Overview {
  const { group, resource } = query.gvr;
  if (subject && "pod" in subject) {
    return podPage(overview, subject.pod, cluster);
  }
  if (subject && cluster) return nodePage(overview, subject.node, cluster);
  const deployment =
    cluster && group === "apps" && resource === "deployments"
      ? deployments(cluster).find(
          (candidate) =>
            candidate.namespace === query.namespace &&
            candidate.name === query.name,
        )
      : undefined;
  if (cluster && deployment)
    return deploymentPage(overview, deployment, cluster);
  const named = (candidate: { namespace: string; name: string }) =>
    candidate.namespace === query.namespace && candidate.name === query.name;
  const job =
    cluster && group === "batch" && resource === "jobs"
      ? cluster.jobs.find(named)
      : undefined;
  if (job) return jobPage(overview, job);
  const cronJob =
    cluster && group === "batch" && resource === "cronjobs"
      ? cluster.cronJobs.find(named)
      : undefined;
  return cluster && cronJob
    ? cronJobPage(overview, cronJob, cluster)
    : overview;
}
