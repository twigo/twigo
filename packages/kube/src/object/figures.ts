import type { Gvr, Measure } from "@twigo/protocol";
import type { Tone } from "@twigo/ui";
import { formatCpu, formatMemory } from "@twigo/utils";

export type Resource = "cpu" | "memory";

const FORMAT: Readonly<Record<Resource, (value: number) => string>> = {
  cpu: formatCpu,
  memory: formatMemory,
};

/** The share of its limit, or of what a node can allocate, from which a measure is a warning. */
const WARN_FROM = 0.9;
/** The share at which it is an error: at the limit or past it. */
const ERROR_FROM = 1;
const MILLI = 1_000_000;

export function hasUsage({ group, resource }: Gvr): boolean {
  return group === "" && (resource === "pods" || resource === "nodes");
}

export type Base = "limit" | "request" | "allocatable";

export interface Figure {
  /** Null while there is no sample, which is no data yet and never zero. */
  readonly used: string | null;
  readonly request: string | null;
  readonly limit: string | null;
  readonly allocatable: string | null;
  readonly base: Base | null;
  /** As kubectl computes it, truncated, and past 100 where a measure passes its base. */
  readonly percent: number | null;
  /** Abnormal only against a limit or what a node can allocate; a request may be passed. */
  readonly tone: Tone | undefined;
  /** The bar: what it is the whole of, and where the request stands. */
  readonly bar: {
    readonly value: number;
    readonly max: number;
    readonly mark?: number;
  } | null;
}

/**
 * A measure as the Overview reads it. What it is held against is, in this
 * order, what a node can allocate, the limit, which a container may not
 * pass, and the request; with none of them the figures are all it has.
 */
export function figure(resource: Resource, measure: Measure): Figure {
  const format = FORMAT[resource];
  const text = (value: number | null) =>
    value === null ? null : format(value);
  const { used, request, limit, allocatable } = measure;
  const [base, whole]: readonly [Base | null, number] =
    allocatable !== null && allocatable > 0
      ? ["allocatable", allocatable]
      : limit !== null && limit > 0
        ? ["limit", limit]
        : request !== null && request > 0
          ? ["request", request]
          : [null, 0];
  const held = used !== null && base !== null;
  const share = held ? used / whole : null;
  return {
    used: text(used),
    request: text(request),
    limit: text(limit),
    allocatable: text(allocatable),
    base,
    percent: held ? percent(resource, used, whole) : null,
    tone:
      share === null || base === "request"
        ? undefined
        : share >= ERROR_FROM
          ? "error"
          : share >= WARN_FROM
            ? "warn"
            : undefined,
    bar: held
      ? {
          value: used,
          max: base === "request" ? Math.max(used, whole) * 1.25 : whole,
          ...(request !== null && { mark: request }),
        }
      : null,
  };
}

/**
 * kubectl's percent: the two in whole thousandths, a CPU's rounded up,
 * divided, times a hundred and truncated ([`printAllResourceUsages`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kubectl/pkg/metricsutil/metrics_printer.go#L224-L241)).
 */
function percent(resource: Resource, used: number, whole: number): number {
  const [a, b] =
    resource === "cpu"
      ? [Math.ceil(used / MILLI), Math.ceil(whole / MILLI)]
      : [used, whole];
  return Math.trunc((a / b) * 100);
}
