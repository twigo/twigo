import { fmtBytes, fmtCount } from "@twigo/utils";
import {
  rateSeries,
  gaugeSeries,
  TOTAL_MSGS,
  TOTAL_BYTES,
  type Sample,
  type SeriesPoint,
} from "@/store/monitor";

export const WINDOWS = [
  { id: "5m", ms: 5 * 60_000 },
  { id: "15m", ms: 15 * 60_000 },
  { id: "1h", ms: 60 * 60_000 },
] as const;

export type WindowId = (typeof WINDOWS)[number]["id"];

export function windowMsOf(id: WindowId): number {
  return WINDOWS.find((w) => w.id === id)?.ms ?? WINDOWS[1].ms;
}

export interface ChartDef {
  id: string;
  title: string;
  series: (samples: Sample[]) => SeriesPoint[];
  format: (v: number) => string;
  // Rates are read against zero or the chart overstates them; a gauge is read
  // against itself, so scaling to its own range is what makes movement visible.
  baseline: "zero" | "auto";
}

export const CHARTS: ChartDef[] = [
  {
    id: "throughput",
    baseline: "zero" as const,
    title: "Throughput",
    series: (s) => rateSeries(s, TOTAL_MSGS),
    format: (v) => `${fmtCount(Math.round(v))}/s`,
  },
  {
    id: "dataRate",
    baseline: "zero" as const,
    title: "Data rate",
    series: (s) => rateSeries(s, TOTAL_BYTES),
    format: (v) => `${fmtBytes(v)}/s`,
  },
  {
    id: "connections",
    baseline: "auto" as const,
    title: "Connections",
    series: (s) => gaugeSeries(s, (x) => x.connections),
    format: fmtCount,
  },
  {
    id: "subscriptions",
    baseline: "auto" as const,
    title: "Subscriptions",
    series: (s) => gaugeSeries(s, (x) => x.subscriptions),
    format: fmtCount,
  },
  {
    id: "memory",
    baseline: "auto" as const,
    title: "Memory",
    series: (s) => gaugeSeries(s, (x) => x.mem),
    format: fmtBytes,
  },
  {
    id: "cpu",
    baseline: "auto" as const,
    title: "CPU",
    series: (s) => gaugeSeries(s, (x) => x.cpu),
    format: (v) => `${v.toFixed(0)}%`,
  },
];

/** The sample nearest the pointer, given where it sits across the chart (0..1). */
export function pointAt(
  points: SeriesPoint[],
  fraction: number,
  windowMs: number,
): SeriesPoint | null {
  const end = points[points.length - 1]?.t;
  if (end === undefined) return null;
  const target = end - (1 - fraction) * windowMs;
  let best: SeriesPoint | null = null;
  let bestDistance = Infinity;
  for (const p of points) {
    const distance = Math.abs(p.t - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = p;
    }
  }
  return best;
}

/** Where a sample sits across the chart (0..1), for placing the hover marker. */
export function fractionOf(
  point: SeriesPoint,
  points: SeriesPoint[],
  windowMs: number,
): number {
  const end = points[points.length - 1]?.t;
  if (end === undefined || windowMs <= 0) return 1;
  return Math.min(1, Math.max(0, 1 - (end - point.t) / windowMs));
}

export function peak(points: SeriesPoint[]): number {
  let max = 0;
  for (const p of points) if (p.v > max) max = p.v;
  return max;
}
