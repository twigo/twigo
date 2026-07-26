import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Sparkline, ToggleGroup, ToggleGroupItem, cn } from "@twigo/ui";
import { fmtTime } from "@twigo/utils";
import { MONITOR_POLL_MS } from "@/hooks/useMonitorPoll";
import type { Sample, SeriesPoint } from "@/store/monitor";
import {
  CHARTS,
  WINDOWS,
  windowMsOf,
  pointAt,
  fractionOf,
  peak,
  type ChartDef,
  type WindowId,
} from "./metrics";

// A pause in sampling (the tab was closed) breaks the line; a slow poll doesn't.
const GAP_MS = MONITOR_POLL_MS * 4;
const CHART_HEIGHT = 48;

function ChartCard({
  def,
  samples,
  windowMs,
  windowId,
}: {
  def: ChartDef;
  samples: Sample[];
  windowMs: number;
  windowId: WindowId;
}) {
  const points = useMemo(() => def.series(samples), [def, samples]);
  const [hover, setHover] = useState<SeriesPoint | null>(null);

  const latest = points[points.length - 1];
  const shown = hover ?? latest;

  return (
    <div className="rounded-md border border-border bg-card px-2.5 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {def.title}
        </span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          peak {def.format(peak(points))}
        </span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-sm tabular-nums">
          {shown ? def.format(shown.v) : "—"}
        </span>
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
          {hover ? fmtTime(hover.t) : "now"}
        </span>
      </div>
      <div
        className="relative mt-1 text-brand"
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setHover(
            pointAt(points, (e.clientX - box.left) / box.width, windowMs),
          );
        }}
        onMouseLeave={() => setHover(null)}
      >
        <Sparkline
          points={points}
          windowMs={windowMs}
          gapMs={GAP_MS}
          height={CHART_HEIGHT}
          label={`${def.title}, last ${windowId}`}
        />
        {hover && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-px bg-brand/60"
            style={{
              left: `${String(fractionOf(hover, points, windowMs) * 100)}%`,
            }}
          />
        )}
      </div>
    </div>
  );
}

export function MetricsSection({ samples }: { samples: Sample[] }) {
  const [windowId, setWindowId] = useState<WindowId>("15m");
  const [open, setOpen] = useState(true);
  const windowMs = windowMsOf(windowId);
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="shrink-0 border-b border-border px-3 py-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          <Chevron className="size-3" />
          Metrics
        </button>
        <ToggleGroup
          type="single"
          value={windowId}
          onValueChange={(v) => {
            if (v) setWindowId(v as WindowId);
          }}
          aria-label="Chart window"
          className={cn("ml-auto", !open && "invisible")}
        >
          {WINDOWS.map((w) => (
            <ToggleGroupItem key={w.id} value={w.id}>
              {w.id}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {open &&
        (samples.length < 2 ? (
          <p className="py-3 text-center text-xs text-muted-foreground">
            Collecting samples — the first points land within a few seconds.
          </p>
        ) : (
          <div className="mt-2 grid grid-cols-2 gap-2 xl:grid-cols-3">
            {CHARTS.map((def) => (
              <ChartCard
                key={def.id}
                def={def}
                samples={samples}
                windowMs={windowMs}
                windowId={windowId}
              />
            ))}
          </div>
        ))}
    </div>
  );
}
