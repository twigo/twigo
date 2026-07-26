import { cn } from "../lib/cn";
import { sparkGeometry, type SparkPoint } from "../lib/sparkline";

export function Sparkline({
  points,
  windowMs,
  gapMs,
  label,
  baseline,
  height = 18,
  className,
}: {
  points: SparkPoint[];
  windowMs: number;
  gapMs: number;
  label: string;
  baseline?: "zero" | "auto";
  height?: number;
  className?: string;
}) {
  const { line, area } = sparkGeometry(points, {
    windowMs,
    gapMs,
    height,
    baseline,
  });

  // Hold the row's height before the first samples land, so nothing shifts.
  if (!line) {
    return <div style={{ height }} className={className} aria-hidden />;
  }

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 100 ${String(height)}`}
      preserveAspectRatio="none"
      style={{ height }}
      className={cn("w-full", className)}
    >
      <path d={area} fill="currentColor" fillOpacity={0.15} />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
