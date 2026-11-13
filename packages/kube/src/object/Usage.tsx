import type { ContainerUsage, Measure, Usage } from "@twigo/protocol";
import { Meter, PropertyList, StatusDot, TonedText } from "@twigo/ui";
import { METRICS_NOTES } from "../list/metrics";
import { variant } from "../variants";
import { figure, type Figure, type Resource } from "./figures";

const LABEL: Readonly<Record<Resource, string>> = {
  cpu: "CPU",
  memory: "Memory",
};

const GRID =
  "grid grid-cols-[3.5rem_minmax(4rem,1fr)_max-content_2.5rem] items-center gap-x-2 gap-y-1";

interface Subject {
  /** What its meters are labelled with. */
  readonly name: string | null;
  /** Whether its name heads its rows. */
  readonly titled: boolean;
  readonly cpu: Measure;
  readonly memory: Measure;
}

/**
 * What a pod or a node uses (ARCHITECTURE 4.3): a pod's total and each of
 * its containers, a node against what it can allocate. A row without a
 * sample says no data yet, never zero, and a Metrics API that gives none
 * says so in place.
 */
export function UsageView({ usage, node }: { usage: Usage; node: boolean }) {
  if (usage.state !== "ready") return <Said state={usage.state} />;
  return (
    <Subjects
      subjects={
        node
          ? [
              {
                name: null,
                titled: false,
                cpu: usage.cpu,
                memory: usage.memory,
              },
            ]
          : [
              {
                name: "Pod",
                titled: true,
                cpu: usage.cpu,
                memory: usage.memory,
              },
              ...usage.containers.map((container) => ({
                name: container.name,
                titled: true,
                cpu: container.cpu,
                memory: container.memory,
              })),
            ]
      }
    />
  );
}

export function UsageTotal({ usage }: { usage: Usage }) {
  if (usage.state !== "ready") return <Said state={usage.state} />;
  return (
    <Subjects
      subjects={[
        { name: null, titled: false, cpu: usage.cpu, memory: usage.memory },
      ]}
    />
  );
}

export function ContainerUsageRows({ usage }: { usage: ContainerUsage }) {
  return (
    <Subjects
      subjects={[
        {
          name: usage.name,
          titled: false,
          cpu: usage.cpu,
          memory: usage.memory,
        },
      ]}
    />
  );
}

function Said({ state }: { state: Exclude<Usage["state"], "ready"> }) {
  return <p className="text-muted-foreground">{METRICS_NOTES[state]}</p>;
}

function Subjects({ subjects }: { subjects: readonly Subject[] }) {
  if (variant("usage") === "text") {
    return (
      <div className="flex flex-col gap-3">
        {subjects.map((subject) => (
          <div key={subject.name ?? ""} className="flex flex-col gap-1">
            {subject.titled && (
              <span className="font-semibold">{subject.name}</span>
            )}
            <PropertyList
              items={(["cpu", "memory"] as const).map((resource) => ({
                key: resource,
                label: LABEL[resource],
                value: <Text shown={figure(resource, subject[resource])} />,
              }))}
            />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className={GRID}>
      {subjects.map((subject) => (
        <Rows key={subject.name ?? ""} subject={subject} />
      ))}
    </div>
  );
}

function Rows({ subject }: { subject: Subject }) {
  return (
    <>
      {subject.titled && (
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

function Text({ shown }: { shown: Figure }) {
  if (shown.used === null) {
    return <span className="text-muted-foreground">No data yet</span>;
  }
  return (
    <span className="tabular-nums">
      {shown.used}
      {shown.percent !== null && (
        <span className="ml-1 inline-flex items-center gap-1">
          {shown.tone && <StatusDot tone={shown.tone} />}
          <TonedText tone={shown.tone ?? "idle"}>({shown.percent}%)</TonedText>
        </span>
      )}
      <span className="text-muted-foreground">{details(shown)}</span>
    </span>
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

function Percent({ shown }: { shown: Figure }) {
  if (shown.percent === null || shown.base === null) return <span />;
  const { tone } = shown;
  return (
    <span
      title={`of ${OF[shown.base]}`}
      className="inline-flex items-center justify-end gap-1 tabular-nums"
    >
      {tone && <StatusDot tone={tone} />}
      <TonedText tone={tone ?? "idle"}>{shown.percent}%</TonedText>
    </span>
  );
}
