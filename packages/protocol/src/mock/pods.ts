import type {
  Condition,
  ContainerState,
  Field,
  Finding,
  Overview,
  Section,
  Span,
} from "../generated";
import {
  backOff,
  CONTAINER_START,
  containerNames,
  containerOf,
  finishedAt,
  imageOf,
  restartCount,
  type Pod,
} from "./cluster";
import { uid } from "./kinds";
import {
  ago,
  amended,
  conditionsSummary,
  event,
  fieldText,
  swapped,
  withEvents,
  words,
} from "./sections";

const SECOND = 1000;

/** When its first container began the run it is in: at its last restart, else with the pod. */
function ranFrom(pod: Pod): number {
  return pod.lastRestart ?? pod.created + CONTAINER_START;
}

/** When its first container's run ended in an error, a moment after it began. */
function erroredAt(pod: Pod): number {
  return Math.min(ranFrom(pod) + 5 * SECOND, pod.received);
}

const time = (label: string, moment: number): Field => ({
  label,
  value: { type: "time", at: new Date(moment).toISOString() },
  default: false,
});

/**
 * How a container ended and when, as Rust's card says it: `code 1 (Error) · 11d
 * ago` for an earlier end, and `code 1 · 11d ago` for one that is its state
 * now, whose reason its state says.
 */
const exit = (label: string, how: string, moment: number): Field => ({
  label,
  value: {
    type: "spans",
    spans: [{ type: "text", text: `${how} · ` }, ago(moment)],
  },
  default: false,
});

function lastRun(pod: Pod): Field[] {
  return restartCount(pod) > 0 && pod.lastRestart !== null
    ? [exit("Last exit", "code 1 (Error)", pod.lastRestart)]
    : [];
}

const running: ContainerState = {
  text: "Running",
  tone: "success",
  ready: true,
  running: true,
  restarts: 0,
};

/**
 * The state of the pod's `index`th container, how it last ended in its row
 * and when it started in its details, as its status and its row say: the
 * first container is the one that restarts, crashes, errors or cannot start,
 * the others run.
 */
export function cardOf(
  pod: Pod,
  index: number,
): { state: ContainerState | null; fields: Field[]; details: Field[] } {
  const first = index === 0;
  const restarts = first ? restartCount(pod) : 0;
  const started = first ? ranFrom(pod) : pod.created + CONTAINER_START;
  const last = first ? lastRun(pod) : [];
  const ended = (
    label: string,
    tone: ContainerState["tone"],
    code: number,
    finished: number,
  ) => ({
    state: {
      text: `Terminated · ${label}`,
      tone,
      ready: false,
      running: false,
      restarts,
    },
    fields: [exit("Exited", `code ${String(code)}`, finished), ...last],
    details: [time("Started", started)],
  });
  const waiting = (reason: string, tone: ContainerState["tone"]) => ({
    state: {
      text: `Waiting · ${reason}`,
      tone,
      ready: false,
      running: false,
      restarts,
    },
    fields: last,
    details: [],
  });
  const up = {
    state: running,
    fields: [],
    details: [time("Started", started)],
  };
  switch (pod.status) {
    case "Pending":
      return { state: null, fields: [], details: [] };
    case "ContainerCreating":
      return waiting("ContainerCreating", "neutral");
    case "Completed":
      return ended("Completed", "neutral", 0, finishedAt(pod));
    case "Error":
      return first ? ended("Error", "danger", 1, erroredAt(pod)) : up;
    case "CrashLoopBackOff":
      return first ? waiting("CrashLoopBackOff", "danger") : up;
    case "ImagePullBackOff":
      return first ? waiting("ImagePullBackOff", "danger") : up;
    default:
      return {
        state:
          first && pod.ready < pod.containers
            ? {
                text: "Running · not ready",
                tone: "warning",
                ready: false,
                running: true,
                restarts,
              }
            : { ...running, restarts },
        fields: last,
        details: [time("Started", started)],
      };
  }
}

function recordedNamespace(overview: Overview): string | undefined {
  const value = overview.sections
    .flatMap((section) => section.blocks)
    .flatMap((block) => (block.type === "fields" ? block.fields : []))
    .find((field) => field.label === "Namespace")?.value;
  return value?.type === "link" ? value.target.name : undefined;
}

/**
 * The recorded pod's texts that name it, its first container and its image,
 * said of the mock pod: the events, the findings and the conditions repeat
 * them.
 */
export function named(recorded: Overview, pod: Pod): Overview {
  const [first] = recorded.sections
    .flatMap((section) => section.blocks)
    .flatMap((block) => (block.type === "containers" ? block.containers : []));
  const name = fieldText(recorded, "Name");
  const namespace = recordedNamespace(recorded);
  const recordedUid = fieldText(recorded, "UID");
  const own = uid(pod.id);
  const pairs = new Map<string, string>();
  if (name !== undefined && namespace !== undefined) {
    pairs.set(`${namespace}/${name}`, `${pod.namespace}/${pod.name}`);
    if (recordedUid !== undefined) {
      pairs.set(
        `${name}_${namespace}(${recordedUid})`,
        `${pod.name}_${pod.namespace}(${own})`,
      );
    }
  }
  if (recordedUid !== undefined) pairs.set(recordedUid, own);
  if (first) {
    const container = containerOf(pod);
    pairs.set(first.image, imageOf(pod));
    pairs.set(`Container ${first.name} `, `Container ${container} `);
    pairs.set(`container ${first.name} `, `container ${container} `);
    pairs.set(`containers{${first.name}}`, `containers{${container}}`);
    pairs.set(`status: [${first.name}]`, `status: [${container}]`);
  }
  return swapped(recorded, pairs, new Map());
}

function refound(
  page: Overview,
  change: (finding: Finding) => Finding,
): Overview {
  return amended(page, "core.diagnostics", (section) => ({
    ...section,
    blocks: section.blocks.map((block) =>
      block.type === "diagnostics"
        ? { ...block, findings: block.findings.map(change) }
        : block,
    ),
  }));
}

/** The pod's own state in the finding the recorded page makes of its first container. */
export function stated(page: Overview, pod: Pod): Overview {
  const restarts = restartCount(pod);
  const last = pod.lastRestart;
  const container = containerOf(pod);
  const own = refound(page, (finding) => ({
    ...finding,
    logs: finding.logs && { ...finding.logs, container },
  }));
  switch (pod.status) {
    case "CrashLoopBackOff":
      return refound(own, (finding) => ({
        ...finding,
        detail: [
          ...words(
            `Exited with code 1, ${restarts === 1 ? "1 restart" : `${String(restarts)} restarts`}`,
          ),
          ...(last === null ? [] : [...words(", last "), ago(last)]),
          ...words("."),
          ...(last === null
            ? []
            : [
                ...words(" Next start "),
                {
                  type: "until" as const,
                  at: new Date(last + backOff(restarts)).toISOString(),
                },
                ...words("."),
              ]),
        ],
      }));
    case "Error":
      return refound(own, (finding) => ({
        ...finding,
        title: `Container ${container} failed`,
        detail: [
          ...words("Exited with code 1 "),
          ago(erroredAt(pod)),
          ...words("."),
        ],
        logs: finding.logs && { ...finding.logs, previous: restarts > 0 },
      }));
    case "Running":
      return refound(own, (finding) => ({
        ...finding,
        detail: [...words("Running since "), ago(ranFrom(pod)), ...words(".")],
      }));
    default:
      return own;
  }
}

/**
 * The events the pod's state leaves of the recorded pod's: one still
 * creating its containers has been scheduled and pulls its image, and one
 * that failed without a restart has no back-off.
 */
export function reported(page: Overview, pod: Pod): Overview {
  const recorded = page.sections
    .filter((section) => section.id === "core.events")
    .flatMap((section) => section.blocks)
    .flatMap((block) => (block.type === "events" ? block.events : []));
  switch (pod.status) {
    case "ContainerCreating": {
      const scheduled = recorded.filter(({ reason }) => reason === "Scheduled");
      const at = Math.max(
        ...scheduled.map(({ last }) => Date.parse(last ?? "")),
      );
      return withEvents(page, [
        ...scheduled,
        event(
          "kubelet",
          "Pulling",
          `Pulling image "${imageOf(pod)}"`,
          at + SECOND,
          { fieldPath: `spec.containers{${containerOf(pod)}}` },
        ),
      ]);
    }
    case "Error":
      return restartCount(pod) === 0
        ? withEvents(
            page,
            recorded.filter(({ reason }) => reason !== "BackOff"),
          )
        : page;
    default:
      return page;
  }
}

export function titleOf(page: Overview): Span[] | undefined {
  const [finding] = page.sections
    .filter((section) => section.id === "core.diagnostics")
    .flatMap((section) => section.blocks)
    .flatMap((block) => (block.type === "diagnostics" ? block.findings : []));
  return finding && words(finding.title);
}

/** A pod whose containers are being created: its readiness is what its containers lack, which tones the header of Conditions and opens nothing. */
export function starting(page: Overview, pod: Pod): Overview {
  const since = new Date(pod.created + CONTAINER_START).toISOString();
  const unready = containerNames(pod).join(" ");
  return amended(page, "core.conditions", (section): Section => {
    const conditions = section.blocks.flatMap((block) =>
      block.type === "conditions" ? block.conditions : [],
    );
    const stated: Condition[] = conditions.map((condition) =>
      condition.type === "Ready" || condition.type === "ContainersReady"
        ? {
            ...condition,
            status: "False",
            tone: "warning",
            reason: "ContainersNotReady",
            message: `containers with unready status: [${unready}]`,
            lastTransition: since,
            explained: false,
          }
        : condition,
    );
    return {
      ...section,
      summary: conditionsSummary(stated),
      tone: "warning",
      blocks: [{ type: "conditions", conditions: stated }],
    };
  });
}
