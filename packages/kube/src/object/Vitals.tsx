import { useState, type ReactNode, type Ref } from "react";
import type { Span, Vital } from "@twigo/protocol";
import { cn, Meter, TonedText, type Tone } from "@twigo/ui";
import { restartedRecently } from "../age";
import { Quantity } from "../Quantity";
import { useNowAs } from "../useNow";
import {
  isCapped,
  LABEL,
  OF,
  shareText,
  spoken,
  type Figure,
  type Resource,
} from "./figures";
import { useClientWidth, useFits } from "./pageStage";
import { TONE } from "./tone";
import { Sentence, ValueView } from "./values";
import type { Verdict } from "./verdict";
import { labelOf, measured, type VitalCell } from "./vitalCells";

const RESTARTS = "Restarts";

/**
 * The cells of an object's vitals (ARCHITECTURE 4.3): a caption over a value,
 * the same height whatever each says, a tone only where a value is abnormal.
 * Under the views it is one row of up to four equal cells, on the full page
 * too. The cells are equal, so the first one's width is the room each takes its
 * measure's words in.
 */
export function Vitals({
  cells,
  verdict,
}: {
  cells: readonly VitalCell[];
  /** A row has one alarm, so a restart that is news stays plain beside the verdict's tone, or once the object finished, or beside a vital that is toned already. */
  verdict: Verdict | undefined;
}) {
  const [first, setFirst] = useState<HTMLElement | null>(null);
  const room = useClientWidth(first);
  if (cells.length === 0) return null;
  const alarmed =
    verdict?.tone !== undefined ||
    verdict?.finished === true ||
    cells.some(
      (cell) =>
        cell.kind === "vital" &&
        cell.vital.label !== RESTARTS &&
        cell.vital.value.type === "toned",
    );
  return (
    <dl
      aria-label="Vitals"
      className="grid grid-cols-4 gap-x-2 px-3.5 shadow-[inset_0_-1px_0_var(--border-subtle)]"
    >
      {cells.map((cell, index) => (
        <Cell
          key={cell.key}
          cell={cell}
          alarmed={alarmed}
          room={room}
          frame={index === 0 ? setFirst : undefined}
        />
      ))}
    </dl>
  );
}

function Cell({
  cell,
  alarmed,
  room,
  frame,
}: {
  cell: VitalCell;
  alarmed: boolean;
  room: number;
  frame: Ref<HTMLDivElement> | undefined;
}) {
  const label = labelOf(cell);
  if (cell.kind === "held")
    return (
      <Frame label={label} frame={frame}>
        <Dash />
      </Frame>
    );
  if (cell.kind === "measure") {
    const shown = measured(cell.usage, cell.resource);
    if (shown.state === "none")
      return (
        <Frame label={label} frame={frame}>
          <Dash reason={shown.reason} />
        </Frame>
      );
    return (
      <Measure
        label={label}
        resource={cell.resource}
        figure={shown.figure}
        room={room}
        frame={frame}
      />
    );
  }
  const { vital } = cell;
  return (
    <Frame label={label} frame={frame}>
      {vital.label === RESTARTS ? (
        <Restarts vital={vital} alarmed={alarmed} />
      ) : (
        <Content vital={vital} />
      )}
    </Frame>
  );
}

function Frame({
  label,
  meter,
  title,
  copies,
  frame,
  children,
}: {
  label: string;
  meter?: ReactNode;
  title?: string | undefined;
  copies?: ReactNode;
  frame: Ref<HTMLDivElement> | undefined;
  children: ReactNode;
}) {
  return (
    <div ref={frame} className="relative flex h-11 min-w-0 flex-col py-1">
      <dt className="truncate text-2xs text-support">{label}</dt>
      <dd
        title={title}
        className="flex min-w-0 items-baseline gap-1 text-body font-semibold whitespace-nowrap text-content"
      >
        {children}
      </dd>
      <div className="mt-auto h-0.5">{meter}</div>
      {copies}
    </div>
  );
}

function Dash({ reason }: { reason?: string }) {
  return (
    <span title={reason} className="text-quiet">
      –{reason !== undefined && <span className="sr-only">{reason}</span>}
    </span>
  );
}

/** What a measure's cell says besides its figure, fullest first. */
type Say = "share" | "base" | "figure";

const COPY =
  "flex w-max items-baseline gap-1 text-body font-semibold whitespace-nowrap";

/**
 * A pod's CPU or Memory: its figure, a meter under it, and as much beside the
 * figure as the cell holds with 16 px to spare: the share and its base in
 * words, else the base's amount, else the figure alone, and the tooltip says
 * what it leaves out. Each fuller form is measured as a hidden copy of the
 * cell's own text, which no stage of the cell changes.
 */
function Measure({
  label,
  resource,
  figure: shown,
  room,
  frame,
}: {
  label: string;
  resource: Resource;
  figure: Figure;
  room: number;
  frame: Ref<HTMLDivElement> | undefined;
}) {
  const [share, setShare] = useState<HTMLElement | null>(null);
  const [base, setBase] = useState<HTMLElement | null>(null);
  const fitsShare = useFits(room, useClientWidth(share));
  const fitsBase = useFits(room, useClientWidth(base));
  const held = shown.base !== null && shown.percent !== null;
  const say: Say = !held
    ? "figure"
    : fitsShare
      ? "share"
      : fitsBase
        ? "base"
        : "figure";
  return (
    <Frame
      label={label}
      frame={frame}
      meter={meterOf(resource, shown)}
      title={
        held && (say !== "share" || isCapped(shown.percent))
          ? spoken(shown)
          : undefined
      }
      copies={
        held && (
          <span
            aria-hidden
            className="pointer-events-none invisible absolute h-0 overflow-hidden"
          >
            <span ref={setShare} className={COPY}>
              <Said figure={shown} say="share" />
            </span>
            <span ref={setBase} className={COPY}>
              <Said figure={shown} say="base" />
            </span>
          </span>
        )
      }
    >
      <Said figure={shown} say={say} />
    </Frame>
  );
}

function Said({ figure: shown, say }: { figure: Figure; say: Say }) {
  const { used, percent, base, tone } = shown;
  const amount = base === null ? null : shown[base];
  return (
    <>
      <TonedText tone={tone ?? "ok"} className="shrink-0 tabular-nums">
        <Quantity text={used ?? ""} />
      </TonedText>
      {say !== "figure" && base !== null && (
        <span className="min-w-0 truncate text-2xs font-normal text-quiet tabular-nums">
          {say === "share" && percent !== null
            ? `${shareText(percent)} of ${OF[base]}`
            : `of ${amount ?? ""}`}
        </span>
      )}
    </>
  );
}

function meterOf(resource: Resource, shown: Figure): ReactNode {
  if (shown.bar === null) return null;
  return (
    <Meter
      label={LABEL[resource]}
      valueText={spoken(shown)}
      {...shown.bar}
      {...(shown.tone && { tone: shown.tone })}
      className="h-0.5 min-w-0"
    />
  );
}

/** A vital as Rust sent it: its value in its own tone, then its note, quieter. */
function Content({
  vital,
  recent = false,
  zero = false,
}: {
  vital: Vital;
  /** The tone of news, which the list gives a restart within the hour, over what Rust said. */
  recent?: boolean;
  /** A zero, which the list draws quiet. */
  zero?: boolean;
}) {
  const { value, note } = vital;
  const tone: Tone | undefined = recent
    ? "warn"
    : value.type === "toned"
      ? TONE[value.tone]
      : undefined;
  return (
    <>
      <span className={cn("shrink-0 tabular-nums", zero && "text-quiet")}>
        {value.type === "text" || value.type === "toned" ? (
          <TonedText tone={tone ?? "ok"}>{value.text}</TonedText>
        ) : (
          <ValueView value={value} onOpen={noop} compact />
        )}
      </span>
      {note.length > 0 && (
        <span
          className={cn(
            "min-w-0 truncate text-2xs font-normal",
            recent ? "text-warn-foreground" : "text-quiet",
          )}
        >
          <Sentence spans={note} />
        </span>
      )}
    </>
  );
}

function noop(): void {
  return undefined;
}

/** When a restart's note says it happened, if it does. */
function lastRestart(note: readonly Span[]): number | undefined {
  const ago = note.find((span) => span.type === "ago");
  return ago ? Date.parse(ago.at) : undefined;
}

/**
 * The Restarts vital by the list's three steps: none quiet, one that lies
 * long past plain, one within the hour in the warning tone, with its age; as
 * the list does, none of it while the row already raises its alarm. Rust tones
 * it itself only where a container finding is its subject, which stays.
 */
function Restarts({ vital, alarmed }: { vital: Vital; alarmed: boolean }) {
  const at = lastRestart(vital.note);
  const recent = useNowAs(
    (now) =>
      !alarmed &&
      vital.value.type !== "toned" &&
      at !== undefined &&
      restartedRecently(now - at),
  );
  return (
    <Content
      vital={vital}
      recent={recent}
      zero={vital.value.type === "text" && vital.value.text === "0"}
    />
  );
}
