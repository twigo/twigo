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
import { FIRST_CHANGE_MS, NEXT_CHANGE_MS, type MockEdits } from "./edits";
import { CRASH_LINE as LAST_LINE } from "./logs";
import OBJECTS from "./objects.json";
import REVEALED from "./revealed.json";

/**
 * Objects described in Rust from kind by `twigo-describe`'s tests, keyed by
 * their fixture's name: the document and the object as views show it.
 */
const RECORDED: Readonly<
  Record<string, { overview: Overview; manifest: string }>
> = OBJECTS as never;

/** What a Reveal of each recorded Secret's keys answers, written by the same test from what Rust reveals. */
const VALUES: Readonly<
  Record<string, Readonly<Record<string, { value: string; binary: boolean }>>>
> = REVEALED;

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

/** How an open object follows what edits leave, and whether it changes on its own. */
export interface EditBinding {
  readonly edits: MockEdits;
  readonly key: string;
  /** `server`: a colleague edits it; `status`: a controller writes its status. */
  readonly change?: "server" | "status";
}

/**
 * An open object of the mock backend: the recorded object of its resource
 * under the name asked for, a pod's in the state of the mock's pod, sent
 * once and again for each part shown later. Its live lists list what the
 * mock has of it: a Deployment's pods, a node's pods.
 */
export class MockObject {
  /** The recorded object it stands for. */
  readonly #fixture: string;
  readonly #overview: Overview;
  #manifest: string;
  readonly #related: Related;
  readonly #stops: (() => void)[] = [];
  readonly #onMessage: (batch: ObjectBatch) => void;
  #parts: ObjectParts;
  #seq = 0;

  constructor(
    query: ObjectQuery,
    parts: ObjectParts,
    cluster: Cluster | undefined,
    onMessage: (batch: ObjectBatch) => void,
    binding?: EditBinding,
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
    if (name === undefined || recorded === undefined) {
      throw new IpcError(
        "notFound",
        `the mock backend has no recorded ${resource}`,
      );
    }
    this.#fixture = name;
    this.#overview = withLastLines(
      listing(renamed(recorded.overview, query), query, cluster),
    );
    const manifest = JSON.parse(recorded.manifest) as {
      metadata: Record<string, unknown>;
    };
    manifest.metadata.name = query.name;
    if (query.namespace !== null) manifest.metadata.namespace = query.namespace;
    this.#manifest = JSON.stringify(
      binding?.edits.get(binding.key) ?? manifest,
    );
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
    if (binding) this.#follow(binding);
  }

  /** Follows what edits leave of the object, and makes the changes a scenario asks for. */
  #follow({ edits, key, change }: EditBinding): void {
    this.#stops.push(
      edits.watch(key, () => {
        const written = edits.get(key);
        if (written === undefined) return;
        this.#manifest = JSON.stringify(written);
        this.#send({ ...NONE, manifest: this.#parts.manifest });
      }),
    );
    if (change === undefined) return;
    let count = 0;
    const next = (wait: number) => {
      const timer = setTimeout(() => {
        const current = JSON.parse(this.#manifest) as Fields;
        edits.put(key, changed(current, change, ++count));
        next(NEXT_CHANGE_MS);
      }, wait);
      this.#stops.push(() => {
        clearTimeout(timer);
      });
    };
    next(FIRST_CHANGE_MS);
  }

  /** Stops following and changing. */
  close(): void {
    for (const stop of this.#stops) stop();
    this.#stops.length = 0;
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

  /** A Secret's value of `key`, as a Reveal answers it. */
  reveal(key: string): { value: string; binary: boolean } {
    const values = VALUES[this.#fixture];
    if (values === undefined) {
      throw new IpcError("invalidInput", "only a Secret's values are revealed");
    }
    const value = values[key];
    if (value === undefined) {
      throw new IpcError("notFound", `the Secret has no key ${key}`);
    }
    return value;
  }

  /** Its namespace and name. */
  get names(): { namespace: string; name: string } {
    const { metadata } = JSON.parse(this.#manifest) as {
      metadata: { namespace?: string; name: string };
    };
    return { namespace: metadata.namespace ?? "", name: metadata.name };
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

type Fields = Record<string, unknown>;

const NONE: ObjectParts = {
  overview: false,
  manifest: false,
  events: false,
  related: false,
};

/** What a colleague or a controller wrote: a label and an annotation, or a tick in the status. */
function changed(
  object: Fields,
  kind: "server" | "status",
  count: number,
): Fields {
  const metadata = (object.metadata ?? {}) as Fields;
  if (kind === "status") {
    return {
      ...object,
      status: { ...(object.status as Fields | undefined), mockTick: count },
    };
  }
  const generation =
    typeof metadata.generation === "number"
      ? metadata.generation + 1
      : undefined;
  return {
    ...object,
    metadata: {
      ...metadata,
      ...(generation !== undefined && { generation }),
      labels: {
        ...(metadata.labels as Fields | undefined),
        "edited-by": `colleague-${String(count)}`,
      },
    },
  };
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
