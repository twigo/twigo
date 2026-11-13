import type { Measure, Usage } from "@twigo/protocol";
import { Meter, StatusDot, TonedText } from "@twigo/ui";
import { METRICS_NOTES } from "../list/metrics";
import { figure, type Figure, type Resource } from "./figures";

const LABEL: Readonly<Record<Resource, string>> = {
  cpu: "CPU",
  memory: "Memory",
};

/**
 * What a pod or a node uses (ARCHITECTURE 4.3): a pod's total and each of
 * its containers, a node against what it can allocate, each as a meter
 * with its figures. A row without a sample says no data yet, never zero,
 * and a Metrics API that gives none says so in place.
 */
export function UsageView({ usage, node }: { usage: Usage; node: boolean }) {
  if (usage.state !== "ready") {
    return (
      <p className="text-muted-foreground">{METRICS_NOTES[usage.state]}</p>
    );
  }
  return (
    <div className="grid grid-cols-[3.5rem_minmax(4rem,1fr)_max-content_2.5rem] items-center gap-x-2 gap-y-1">
      {node ? (
        <Subject title={null} cpu={usage.cpu} memory={usage.memory} />
      ) : (
        <>
          <Subject title="Pod" cpu={usage.cpu} memory={usage.memory} />
          {usage.containers.map((container) => (
            <Subject
              key={container.name}
              title={container.name}
              cpu={container.cpu}
              memory={container.memory}
            />
          ))}
        </>
      )}
    </div>
  );
}

function Subject({
  title,
  cpu,
  memory,
}: {
  title: string | null;
  cpu: Measure;
  memory: Measure;
}) {
  return (
    <>
      {title !== null && (
        <span className="col-span-4 mt-2 font-semibold first:mt-0">
          {title}
        </span>
      )}
      <Row resource="cpu" measure={cpu} subject={title} />
      <Row resource="memory" measure={memory} subject={title} />
    </>
  );
}

function Row({
  resource,
  measure,
  subject,
}: {
  resource: Resource;
  measure: Measure;
  subject: string | null;
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
              label={subject === null ? label : `${label} of ${subject}`}
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
