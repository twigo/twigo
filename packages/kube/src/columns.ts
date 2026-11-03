import type { Column, Gvr, ValueCount } from "@twigo/protocol";
import type { Tone } from "@twigo/ui";

/** How a cell draws its text (ARCHITECTURE 4.4). */
export type CellKind =
  /** An object's name, its generated part quieter. */
  | "name"
  /** A state: a dot in its tone, and the text coloured when abnormal. */
  | "status"
  /** `ready/total`, pending while short of its total. */
  | "ratio"
  /** A count and when it last moved: `3 (28m ago)`. */
  | "restarts"
  /** The time since `created`. */
  | "age"
  | "text";

/** What a column of a resource's table does, as data. */
export interface ColumnRule {
  readonly cell: CellKind;
  /** The starting width in px. */
  readonly width: number;
  /** Takes the free width while the user has not sized it. */
  readonly grow: boolean;
  readonly align: "start" | "end";
  /** Places a row rather than says what it is, so it reads quieter. */
  readonly quiet: boolean;
  /** The table can group its rows by the column's values. */
  readonly groups: boolean;
  /** Rows take their health from this column: the list counts and filters by it. */
  readonly health: boolean;
  /** The tone of an abnormal value; healthy values have none. */
  readonly tone?: (text: string) => Tone | undefined;
}

/**
 * A pod's Status as Kubernetes prints it (printPod in kubernetes v1.37.1
 * pkg/printers/internalversion/printers.go): the phase or the pod's
 * reason; a container's waiting or terminated reason, else `Signal:N` or
 * `ExitCode:N`; an init container's the same after `Init:`, or `Init:i/n`
 * while they run; `SchedulingGated`, `NotReady`, `Terminating`, `Unknown`.
 * Kubelets, runtimes and admission keep adding reasons (`OutOfcpu`,
 * `NodeAffinity`), so a status neither healthy nor waiting fails.
 */
const POD_HEALTHY: ReadonlySet<string> = new Set([
  "Running",
  "Completed",
  "Succeeded",
  "ExitCode:0",
]);
const POD_WAITING: ReadonlySet<string> = new Set([
  "Pending",
  "ContainerCreating",
  "PodInitializing",
  "SchedulingGated",
  "NotReady",
  "Terminating",
  "RestartingAllContainers",
]);
const INIT_RUNNING = /^Init:\d+\/\d+$/;

/** A pod's status: what fails, and what waits. */
function podStatus(text: string): Tone | undefined {
  if (INIT_RUNNING.test(text)) return "warn";
  const state = text.startsWith("Init:") ? text.slice("Init:".length) : text;
  if (POD_HEALTHY.has(state)) return undefined;
  return POD_WAITING.has(state) ? "warn" : "error";
}

/** A ratio such as Ready's `1/2` is pending until both sides match. */
function ratio(text: string): Tone | undefined {
  const [ready, total] = text.split("/");
  return ready !== undefined && total !== undefined && ready !== total
    ? "warn"
    : undefined;
}

/** A node's Status: not ready, or never reported, fails. */
function nodeStatus(text: string): Tone | undefined {
  return /^(NotReady|Unknown)/.test(text) ? "error" : undefined;
}

/** States still in flight, whose dot pulses. */
export const IN_FLIGHT =
  /^(ContainerCreating|PodInitializing|Terminating|RestartingAllContainers|Init:\d+\/\d+)$/;

/** Rules for a column of any kind, by name. */
const BY_NAME: Readonly<Record<string, Partial<ColumnRule>>> = {
  Name: { cell: "name", width: 280, grow: true },
  Namespace: { width: 120, quiet: true, groups: true },
  Context: { width: 120, quiet: true, groups: true },
  Node: { width: 200, groups: true },
};

/** Rules for one resource's column, by `group/resource/column`, over those by name. */
const BY_RESOURCE: Readonly<Record<string, Partial<ColumnRule>>> = {
  "/pods/Ready": { cell: "ratio", width: 56, align: "end", tone: ratio },
  "/pods/Status": {
    cell: "status",
    width: 160,
    groups: true,
    health: true,
    tone: podStatus,
  },
  "/pods/Restarts": { cell: "restarts", width: 132 },
  "/nodes/Status": {
    cell: "status",
    width: 160,
    groups: true,
    health: true,
    tone: nodeStatus,
  },
  "apps/deployments/Ready": {
    cell: "ratio",
    width: 64,
    align: "end",
    health: true,
    tone: ratio,
  },
};

function key(gvr: Gvr, column: string): string {
  return `${gvr.group}/${gvr.resource}/${column}`;
}

/** A column's rule: its kind's defaults, then its name's, then its resource's. */
export function columnRule(gvr: Gvr, column: Column): ColumnRule {
  const numeric = column.kind === "integer" || column.kind === "number";
  const age = column.kind === "age";
  return {
    cell: age ? "age" : "text",
    width: age ? 64 : numeric ? 88 : 140,
    grow: false,
    align: age || numeric ? "end" : "start",
    quiet: age,
    groups: false,
    health: false,
    ...BY_NAME[column.name],
    ...BY_RESOURCE[key(gvr, column.name)],
  };
}

/** The column that carries a resource's health, which its list counts and filters by. */
export function statusColumn(gvr: Gvr): string | undefined {
  const prefix = `${gvr.group}/${gvr.resource}/`;
  const found = Object.entries(BY_RESOURCE).find(
    ([id, rule]) => id.startsWith(prefix) && rule.health === true,
  );
  return found?.[0].slice(prefix.length);
}

/** The tone of a value in a column, if it is abnormal. */
export function cellTone(
  gvr: Gvr,
  column: string,
  text: string,
): Tone | undefined {
  return BY_RESOURCE[key(gvr, column)]?.tone?.(text);
}

/** A row's health by its status column: healthy, or the tone of an abnormal state. */
export type Health = "ok" | "warn" | "error";

export const HEALTH: Readonly<
  Record<Health, { readonly name: string; readonly title: string }>
> = {
  ok: { name: "healthy", title: "Healthy" },
  warn: { name: "pending", title: "Pending" },
  error: { name: "failing", title: "Failing" },
};

export interface HealthCount {
  readonly health: Health;
  readonly count: number;
  readonly values: readonly ValueCount[];
}

/** The status column's values by health, each with its rows. */
export function byHealth(
  gvr: Gvr,
  column: string,
  counts: readonly ValueCount[],
): Readonly<Record<Health, HealthCount>> {
  const result: Record<Health, HealthCount> = {
    ok: { health: "ok", count: 0, values: [] },
    warn: { health: "warn", count: 0, values: [] },
    error: { health: "error", count: 0, values: [] },
  };
  for (const value of counts) {
    const tone = cellTone(gvr, column, value.value);
    const health: Health = tone === "error" || tone === "warn" ? tone : "ok";
    const current = result[health];
    result[health] = {
      health,
      count: current.count + value.count,
      values: [...current.values, value],
    };
  }
  return result;
}

/** A health's values, sorted, so counts that swap keep the list's query. */
export function healthValues(count: HealthCount): string[] {
  return count.values.map((value) => value.value).sort();
}

/** The worst health among counts, for a dot that sums a list or a group up. */
export function worstHealth(
  counts: Readonly<Record<Health, HealthCount>>,
): Health {
  if (counts.error.count > 0) return "error";
  if (counts.warn.count > 0) return "warn";
  return "ok";
}
