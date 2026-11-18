import type { ReactNode } from "react";
import type { Measure, ShownUsage } from "@twigo/protocol";
import { EmptyMeter, Meter, StatusDot, TonedText } from "@twigo/ui";
import { METRICS_NOTES } from "../list/metrics";
import { Quantity } from "../Quantity";
import { figure, LABEL, type Figure, type Resource } from "./figures";

const GRID =
  "grid grid-cols-[3.5rem_minmax(4rem,11rem)_max-content_2.5rem] items-center gap-x-2 gap-y-1";

/**
 * What a node uses (ARCHITECTURE 4.3), against what it can allocate. A row
 * without a sample says no data yet, never zero, and a Metrics API that
 * gives none says so in place. A usage that waits for its first answer draws
 * its rows with empty meters, so the answer moves nothing below it.
 */
export function UsageView({ usage }: { usage: ShownUsage }) {
  if (usage.state !== "ready") return <UsageNote state={usage.state} />;
  const measures = usage.waiting
    ? { cpu: null, memory: null }
    : { cpu: usage.cpu, memory: usage.memory };
  return (
    <div className={GRID}>
      {(["cpu", "memory"] as const).map((resource) => (
        <NodeRow
          key={resource}
          resource={resource}
          measure={measures[resource]}
        />
      ))}
    </div>
  );
}

export function UsageNote({
  state,
}: {
  state: Exclude<ShownUsage["state"], "ready">;
}) {
  return <p className="text-support">{METRICS_NOTES[state]}</p>;
}

interface Parts {
  readonly shown: Figure;
  readonly used: string;
  readonly meter: ReactNode;
}

function partsOf(
  resource: Resource,
  shown: Figure,
  name: string | null,
  className?: string,
): Parts | "no data" {
  if (shown.used === null) return "no data";
  return {
    shown,
    used: shown.used,
    meter: shown.bar ? (
      <Meter
        label={subject(resource, name)}
        valueText={spoken(shown)}
        {...shown.bar}
        {...(shown.tone && { tone: shown.tone })}
        {...(className !== undefined && { className })}
      />
    ) : null,
  };
}

const subject = (resource: Resource, name: string | null) =>
  name === null ? LABEL[resource] : `${LABEL[resource]} of ${name}`;

function NodeRow({
  resource,
  measure,
}: {
  resource: Resource;
  measure: Measure | null;
}) {
  const label = (
    <span className="text-label text-support">{LABEL[resource]}</span>
  );
  if (measure === null) {
    return (
      <>
        {label}
        <EmptyMeter label={subject(resource, null)} />
        <span aria-hidden className="col-span-2">
          {" "}
        </span>
      </>
    );
  }
  const parts = partsOf(resource, figure(resource, measure), null);
  if (parts === "no data") {
    return (
      <>
        {label}
        <span className="col-span-3 text-support">No data yet</span>
      </>
    );
  }
  return (
    <>
      {label}
      {parts.meter ?? <span />}
      <span className="tabular-nums">
        <Quantity text={parts.used} />
        <span className="text-support">
          <Allocatable shown={parts.shown} />
        </span>
      </span>
      <Percent shown={parts.shown} />
    </>
  );
}

const METER = "w-20";

/**
 * A container's CPU or Memory in one form whatever it has to say, so that no
 * answer moves what is below it: two lines, each holding the height of a line
 * of text while it is empty. With something to hold the figure against, the
 * first line is the meter and how much of its base the container uses, and the
 * second the figure itself; a container that has neither request nor limit has
 * the figure alone, on the first line. While the usage waits, the meter is
 * empty where a base exists and the line is bare where none does. The first
 * line begins with a zero-width space, its gap cancelled, in every state: the
 * row takes its baseline from text, as the rows around it do, and not from a
 * meter's edge, so its label keeps its place as the answer comes.
 */
export function ContainerMeter({
  resource,
  measure,
  waiting,
  name,
}: {
  resource: Resource;
  measure: Measure;
  waiting: boolean;
  name: string;
}) {
  const shown = figure(resource, measure);
  const parts = waiting ? null : partsOf(resource, shown, name, METER);
  const based = shown.base !== null;
  return (
    <span className="flex flex-col">
      <span className="flex min-h-lh items-center gap-2">
        <span aria-hidden className="-mr-2">
          {"\u200b"}
        </span>
        {parts === null ? (
          based && (
            <EmptyMeter label={subject(resource, name)} className={METER} />
          )
        ) : parts === "no data" ? (
          <span className="text-support">No data yet</span>
        ) : based ? (
          <>
            {parts.meter}
            <Percent shown={shown} said />
          </>
        ) : (
          <span className="tabular-nums">
            <Quantity text={parts.used} />
          </span>
        )}
      </span>
      <span className="min-h-lh whitespace-nowrap tabular-nums">
        {parts !== null && parts !== "no data" && based && (
          <Quantity text={parts.used} />
        )}
      </span>
    </span>
  );
}

function Allocatable({ shown: { base, allocatable } }: { shown: Figure }) {
  if (base !== "allocatable") return null;
  return (
    <>
      {" of "}
      <Quantity text={allocatable ?? ""} />
    </>
  );
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

/** The share of its base, with the base in words where nothing else says it. */
function Percent({ shown, said = false }: { shown: Figure; said?: boolean }) {
  if (shown.percent === null || shown.base === null) return <span />;
  const { tone } = shown;
  return (
    <span
      title={said ? undefined : `of ${OF[shown.base]}`}
      className="inline-flex items-center justify-end gap-1 whitespace-nowrap tabular-nums"
    >
      {tone && <StatusDot tone={tone} label={TONE_WORDS[tone]} />}
      <TonedText tone={tone ?? "idle"}>{shown.percent}%</TonedText>
      {said && (
        <>
          {" "}
          <span className="text-support">of {OF[shown.base]}</span>
        </>
      )}
    </span>
  );
}
