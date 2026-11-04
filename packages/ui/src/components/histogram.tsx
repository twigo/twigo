import { useRef, useState, type PointerEvent } from "react";
import { cn } from "../lib/cn";

export interface HistogramBucket {
  readonly total: number;
  readonly warnings: number;
  readonly errors: number;
}

/** A span of the histogram as fractions of its width, from 0 to 1. */
export interface HistogramSpan {
  readonly from: number;
  readonly to: number;
}

/**
 * Volume over time as bars, warnings and errors in their tones at the
 * foot of each (ARCHITECTURE 4.6); a drag across it picks a span.
 */
export function Histogram({
  label,
  buckets,
  ticks,
  selection,
  onSelect,
  className,
}: {
  label: string;
  buckets: readonly HistogramBucket[];
  /** Labels spread evenly under the bars, the first at the left edge. */
  ticks: readonly string[];
  selection?: HistogramSpan | undefined;
  onSelect: (span: HistogramSpan) => void;
  className?: string;
}) {
  const bars = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<HistogramSpan | undefined>(undefined);
  const peak = Math.max(1, ...buckets.map((bucket) => bucket.total));
  const at = (event: PointerEvent) => {
    const box = bars.current?.getBoundingClientRect();
    if (!box || box.width === 0) return 0;
    return Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
  };
  const shown = clamp(drag ?? selection);
  return (
    <div className={cn("flex-none px-3 pt-1", className)}>
      <div
        ref={bars}
        role="img"
        aria-label={label}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          const from = at(event);
          setDrag({ from, to: from });
        }}
        onPointerMove={(event) => {
          if (drag) setDrag({ from: drag.from, to: at(event) });
        }}
        onPointerUp={(event) => {
          if (!drag) return;
          const to = at(event);
          setDrag(undefined);
          const width = 1 / buckets.length;
          const [low, high] =
            drag.from <= to ? [drag.from, to] : [to, drag.from];
          // A click picks its bucket's span.
          const bucket = Math.min(buckets.length - 1, Math.floor(low / width));
          onSelect(
            high - low < width / 2
              ? { from: bucket * width, to: (bucket + 1) * width }
              : { from: low, to: high },
          );
        }}
        className="relative flex h-[26px] cursor-crosshair items-end gap-0.5 select-none"
      >
        {buckets.map((bucket, index) => (
          <span
            key={index}
            className="flex min-w-0 flex-1 flex-col-reverse overflow-hidden rounded-[1px] bg-foreground/16"
            style={{
              height: `${String(bucket.total === 0 ? 0 : Math.max(8, (bucket.total / peak) * 100))}%`,
            }}
          >
            <i
              className="block flex-none bg-error"
              style={{
                height: `${String((bucket.errors / Math.max(1, bucket.total)) * 100)}%`,
              }}
            />
            <i
              className="block flex-none bg-warn"
              style={{
                height: `${String((bucket.warnings / Math.max(1, bucket.total)) * 100)}%`,
              }}
            />
          </span>
        ))}
        {shown && (
          <span
            className="pointer-events-none absolute -inset-y-0.5 rounded-[3px] bg-brand/14 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--brand)_55%,transparent)]"
            style={{
              left: `${String(shown.from * 100)}%`,
              width: `${String((shown.to - shown.from) * 100)}%`,
            }}
          />
        )}
      </div>
      <div className="flex h-4 items-center justify-between text-[10px] text-muted-foreground tabular-nums">
        {ticks.map((tick, index) => (
          <span key={index}>{tick}</span>
        ))}
      </div>
    </div>
  );
}

/** A span inside the bars, as a selection that the histogram's span moved past is drawn. */
function clamp(span: HistogramSpan | undefined): HistogramSpan | undefined {
  if (!span) return undefined;
  const from = Math.max(0, Math.min(1, Math.min(span.from, span.to)));
  const to = Math.max(0, Math.min(1, Math.max(span.from, span.to)));
  return to > from ? { from, to } : undefined;
}
