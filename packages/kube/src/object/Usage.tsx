import type { Measure, ShownUsage } from "@twigo/protocol";
import { Meter, StatusDot, TonedText } from "@twigo/ui";
import { METRICS_NOTES } from "../list/metrics";
import { figure, type Figure, type Resource } from "./figures";

const LABEL: Readonly<Record<Resource, string>> = {
  cpu: "CPU",
  memory: "Memory",
};

const GRID =
  "grid grid-cols-[3.5rem_minmax(4rem,1fr)_max-content_2.5rem] items-center gap-x-2 gap-y-1";

interface Subject {
  /** What its meters are labelled with, and its heading when it has one. */
  readonly name: string | null;
  readonly cpu: Measure;
  readonly memory: Measure;
}

/**
 * What a pod or a node uses (ARCHITECTURE 4.3): a pod's total and each of
 * its containers, a node against what it can allocate. A row without a
 * sample says no data yet, never zero, and a Metrics API that gives none
 * says so in place.
 */
export function UsageView({
  usage,
  node,
}: {
  usage: ShownUsage;
  node: boolean;
}) {
  if (usage.state !== "ready") return <Said state={usage.state} />;
  const subjects: readonly Subject[] = node
    ? [{ name: null, cpu: usage.cpu, memory: usage.memory }]
    : [
        { name: "Pod", cpu: usage.cpu, memory: usage.memory },
        ...usage.containers.map(({ name, cpu, memory }) => ({
          name,
          cpu,
          memory,
        })),
      ];
  return (
    <div className={GRID}>
      {subjects.map((subject) => (
        <Rows key={subject.name ?? ""} subject={subject} />
      ))}
    </div>
  );
}

function Said({ state }: { state: Exclude<ShownUsage["state"], "ready"> }) {
  return <p className="text-muted-foreground">{METRICS_NOTES[state]}</p>;
}

function Rows({ subject }: { subject: Subject }) {
  return (
    <>
      {subject.name !== null && (
        <span className="col-span-4 mt-2 font-semibold first:mt-0">
          {subject.name}
        </span>
      )}
      <Row resource="cpu" measure={subject.cpu} name={subject.name} />
      <Row resource="memory" measure={subject.memory} name={subject.name} />
    </>
  );
}

function Row({
  resource,
  measure,
  name,
}: {
  resource: Resource;
  measure: Measure;
  name: string | null;
}) {
  const label = LABEL[resource];
  const shown = figure(resource, measure);
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      {shown.used === null ? (
        <span className="col-span-3 text-muted-foreground">No data yet</span>
      ) : (
        <>
          {shown.bar ? (
            <Meter
              label={name === null ? label : `${label} of ${name}`}
              valueText={spoken(shown)}
              {...shown.bar}
              {...(shown.tone && { tone: shown.tone })}
            />
          ) : (
            <span />
          )}
          <span className="tabular-nums">
            {shown.used}
            <span className="text-muted-foreground">{details(shown)}</span>
          </span>
          <Percent shown={shown} />
        </>
      )}
    </>
  );
}

function details({ base, limit, request, allocatable }: Figure): string {
  if (base === "allocatable") return ` of ${allocatable ?? ""}`;
  return [
    ` · ${limit === null ? "no limit" : `limit ${limit}`}`,
    request === null ? "" : ` · request ${request}`,
  ].join("");
}

const OF = { limit: "limit", request: "request", allocatable: "allocatable" };

const TONE_WORDS = { warn: "Warning", error: "Error" } as const;

function spoken(shown: Figure): string {
  const { used, base, percent, tone } = shown;
  const against = base === null ? "" : ` of ${shown[base] ?? ""} ${OF[base]}`;
  return [
    `${used ?? ""}${against}`,
    percent === null ? "" : `${String(percent)}%`,
    tone === undefined ? "" : TONE_WORDS[tone].toLowerCase(),
  ]
    .filter((part) => part !== "")
    .join(", ");
}

function Percent({ shown }: { shown: Figure }) {
  if (shown.percent === null || shown.base === null) return <span />;
  const { tone } = shown;
  return (
    <span
      title={`of ${OF[shown.base]}`}
      className="inline-flex items-center justify-end gap-1 tabular-nums"
    >
      {tone && <StatusDot tone={tone} label={TONE_WORDS[tone]} />}
      <TonedText tone={tone ?? "idle"}>{shown.percent}%</TonedText>
    </span>
  );
}
