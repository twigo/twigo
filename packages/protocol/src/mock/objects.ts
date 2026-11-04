import { IpcError } from "../error";
import type {
  Block,
  EventList,
  ObjectBatch,
  ObjectParts,
  ObjectQuery,
  Overview,
  Related,
  RelatedObject,
  Value,
} from "../generated";
import { replicaSetUid, type Cluster, type Pod } from "./cluster";
import { CRASH_LINE as LAST_LINE } from "./logs";
import OBJECTS from "./objects.json";

/**
 * Objects described in Rust from kind by `twigo-describe`'s tests, keyed by
 * their fixture's name: the document and the object as views show it.
 */
const RECORDED: Readonly<
  Record<string, { overview: Overview; manifest: string }>
> = OBJECTS as never;

/** The recorded object that stands for any object of a resource. */
const BY_RESOURCE: Readonly<Record<string, string>> = {
  "/v1/pods": "pod",
  "apps/v1/deployments": "deployment",
  "apps/v1/replicasets": "replicaset",
  "apps/v1/statefulsets": "statefulset",
  "apps/v1/daemonsets": "daemonset",
  "batch/v1/jobs": "job",
  "batch/v1/cronjobs": "cronjob",
  "/v1/services": "service",
  "networking.k8s.io/v1/ingresses": "ingress",
  "/v1/persistentvolumeclaims": "pvc",
  "/v1/configmaps": "configmap",
  "/v1/secrets": "secret",
  "/v1/nodes": "node",
  "kwok.x-k8s.io/v1alpha1/stages": "stage",
};

/**
 * The recorded pod in the state a mock pod's status names; one that runs
 * short of ready containers is the unready one, and any other the healthy
 * one, as the mock records no completed or creating pod.
 */
function podFixture(pod: Pod | undefined): string {
  switch (pod?.status) {
    case "CrashLoopBackOff":
    case "Error":
      return "pod-crashing";
    case "ImagePullBackOff":
      return "pod-pulling";
    case "Pending":
      return "pod-pending";
    case "Running":
      return pod.ready < pod.containers ? "pod-unready" : "pod";
    default:
      return "pod";
  }
}

/**
 * An open object of the mock backend: the recorded object of its resource
 * under the name asked for, a pod's in the state of the mock's pod, sent
 * once and again for each part shown later. Its live lists list what the
 * mock has of it: a Deployment's pods, a node's pods.
 */
export class MockObject {
  readonly #overview: Overview;
  readonly #manifest: string;
  readonly #related: Related;
  readonly #onMessage: (batch: ObjectBatch) => void;
  #parts: ObjectParts;
  #seq = 0;

  constructor(
    query: ObjectQuery,
    parts: ObjectParts,
    cluster: Cluster | undefined,
    onMessage: (batch: ObjectBatch) => void,
  ) {
    const { group, version, resource } = query.gvr;
    const pod = cluster?.pods.find(
      (candidate) =>
        candidate.namespace === query.namespace &&
        candidate.name === query.name,
    );
    const name =
      resource === "pods" && group === ""
        ? podFixture(pod)
        : BY_RESOURCE[`${group}/${version}/${resource}`];
    const recorded = name === undefined ? undefined : RECORDED[name];
    if (recorded === undefined) {
      throw new IpcError(
        "notFound",
        `the mock backend has no recorded ${resource}`,
      );
    }
    this.#overview = withLastLines(
      listing(renamed(recorded.overview, query), query, cluster),
    );
    const manifest = JSON.parse(recorded.manifest) as {
      metadata: Record<string, unknown>;
    };
    manifest.metadata.name = query.name;
    if (query.namespace !== null) manifest.metadata.namespace = query.namespace;
    this.#manifest = JSON.stringify(manifest);
    this.#related = {
      owners: owners(this.#overview),
      owned: [],
      unavailable: null,
    };
    this.#onMessage = onMessage;
    this.#parts = parts;
    setTimeout(() => {
      this.#send(parts);
    }, 0);
  }

  setParts(parts: ObjectParts): void {
    const shown: ObjectParts = {
      overview: parts.overview && !this.#parts.overview,
      manifest: parts.manifest && !this.#parts.manifest,
      events: parts.events && !this.#parts.events,
      related: parts.related && !this.#parts.related,
    };
    this.#parts = parts;
    this.#send(shown);
  }

  values(keys: readonly string[]): (string | null)[] {
    const object = JSON.parse(this.#manifest) as {
      kind?: string;
      data?: Record<string, string>;
    };
    if (object.kind !== "ConfigMap") {
      throw new IpcError("forbidden", "only a ConfigMap's values are sent");
    }
    return keys.map((key) => object.data?.[key] ?? null);
  }

  #send(parts: ObjectParts): void {
    this.#seq += 1;
    this.#onMessage({
      seq: this.#seq,
      status: { state: "ready" },
      exists: true,
      overview: parts.overview ? this.#overview : null,
      manifest: parts.manifest ? this.#manifest : null,
      events: parts.events ? events(this.#overview) : null,
      related: parts.related ? this.#related : null,
    });
  }
}

/** The recorded document with the metadata's name and namespace asked for. */
function renamed(overview: Overview, query: ObjectQuery): Overview {
  const rename = (label: string, value: Value): Value => {
    if (label === "Name") return { type: "text", text: query.name };
    if (label === "Namespace" && value.type === "link" && query.namespace)
      return {
        ...value,
        target: { ...value.target, name: query.namespace },
        text: query.namespace,
      };
    return value;
  };
  return {
    sections: overview.sections.map((section) =>
      section.id !== "core.metadata"
        ? section
        : {
            ...section,
            blocks: section.blocks.map((block) =>
              block.type !== "fields"
                ? block
                : {
                    ...block,
                    fields: block.fields.map((field) => ({
                      ...field,
                      value: rename(field.label, field.value),
                    })),
                  },
            ),
          },
    ),
  };
}

/**
 * The document's live lists over the mock's objects: a Deployment's pods
 * by the mock's ReplicaSets of it, a node's pods by its name, and none of
 * the objects the mock does not serve.
 */
/**
 * The last line a crashed container wrote, which Rust reads once per
 * restart and the recorded objects lack: the crash the mock's logs write.
 */
function withLastLines(overview: Overview): Overview {
  const filled = (block: Block): Block =>
    block.type === "diagnostics"
      ? {
          ...block,
          findings: block.findings.map((finding) =>
            finding.logs?.previous
              ? { ...finding, logs: { ...finding.logs, lastLine: LAST_LINE } }
              : finding,
          ),
        }
      : block;
  return {
    sections: overview.sections.map((section) => ({
      ...section,
      blocks: section.blocks.map(filled),
    })),
  };
}

function listing(
  overview: Overview,
  query: ObjectQuery,
  cluster: Cluster | undefined,
): Overview {
  const rewired = (block: Block): Block => {
    if (block.type !== "list") return block;
    if (block.fieldSelector?.startsWith("spec.nodeName=")) {
      return { ...block, fieldSelector: `spec.nodeName=${query.name}` };
    }
    if (block.owners === null) return block;
    const owners =
      query.gvr.resource === "deployments" && cluster && query.namespace
        ? [replicaSetUid(cluster.context, query.namespace, query.name)]
        : [];
    return { ...block, namespace: query.namespace, owners };
  };
  return {
    sections: overview.sections.map((section) => ({
      ...section,
      blocks: section.blocks.map(rewired),
    })),
  };
}

function events(overview: Overview): EventList {
  for (const section of overview.sections) {
    for (const block of section.blocks) {
      if (block.type === "events")
        return { events: block.events, unavailable: block.unavailable };
    }
  }
  return { events: [], unavailable: null };
}

/** The owners the metadata section links to. */
function owners(overview: Overview): RelatedObject[] {
  const related: RelatedObject[] = [];
  for (const section of overview.sections) {
    if (section.id !== "core.metadata") continue;
    for (const block of section.blocks) {
      if (block.type !== "fields") continue;
      for (const field of block.fields) {
        if (field.label !== "Controlled by" && field.label !== "Owners")
          continue;
        const values =
          field.value.type === "list" ? field.value.items : [field.value];
        for (const value of values) {
          if (value.type === "link")
            related.push({
              target: value.target,
              controller: field.label === "Controlled by",
            });
        }
      }
    }
  }
  return related;
}
