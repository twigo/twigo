export interface SparkPoint {
  t: number;
  v: number;
}

export interface SparkOptions {
  // The span the axis covers, whatever the history holds. A shorter history
  // occupies its true share of the width and leaves the rest empty, so the time
  // scale stays fixed instead of rescaling under the reader as points arrive.
  windowMs: number;
  // Past this, a pause in sampling reads as a gap rather than a line across it.
  gapMs: number;
  height: number;
  // "zero" holds the baseline at 0, which a rate needs or the chart exaggerates
  // it. "auto" scales to the values, so a gauge that barely moves still reads as
  // a line instead of a solid block filling the box.
  baseline?: "zero" | "auto";
  width?: number;
  pad?: number;
}

export interface SparkGeometry {
  line: string;
  area: string;
  yMax: number;
  spanMs: number;
}

const EMPTY: SparkGeometry = { line: "", area: "", yMax: 0, spanMs: 0 };

const round = (n: number) => Math.round(n * 100) / 100;

/** How much time the chart actually covers: the history, capped at the window. */
export function sparkSpan(points: { t: number }[], windowMs: number): number {
  const end = points[points.length - 1]?.t;
  if (end === undefined || windowMs <= 0) return 0;
  const oldest = points.find((p) => p.t >= end - windowMs)?.t ?? end;
  return Math.min(windowMs, end - oldest);
}

/** SVG paths for a sparkline over `points`, which must be ascending in `t`. */
export function sparkGeometry(
  points: SparkPoint[],
  {
    windowMs,
    gapMs,
    height,
    baseline = "zero",
    width = 100,
    pad = 1,
  }: SparkOptions,
): SparkGeometry {
  const end = points[points.length - 1]?.t;
  if (end === undefined || windowMs <= 0) return EMPTY;

  const visible = points.filter((p) => p.t >= end - windowMs);
  const spanMs = sparkSpan(points, windowMs);

  let lo = Infinity;
  let hi = -Infinity;
  for (const p of visible) {
    if (p.v < lo) lo = p.v;
    if (p.v > hi) hi = p.v;
  }
  if (baseline === "zero" || !Number.isFinite(lo)) lo = 0;

  const base = height - pad;
  const drawable = height - pad * 2;
  // Nothing to scale into. An unchanging gauge reads best through the middle;
  // an all-zero rate has to stay on the floor, because zero is what it means.
  const flat = !(hi > lo);
  const flatY = baseline === "auto" ? base - drawable / 2 : base;
  const x = (t: number) => round(width - ((end - t) / windowMs) * width);
  const y = (v: number) =>
    round(flat ? flatY : base - ((v - lo) / (hi - lo)) * drawable);

  const line: string[] = [];
  const area: string[] = [];
  let segment: SparkPoint[] = [];

  const flush = () => {
    const first = segment[0];
    const last = segment[segment.length - 1];
    if (!first || !last) return;
    const coords = segment.map((p) => `${x(p.t)},${y(p.v)}`);
    // A lone sample draws a zero-length line, which a round cap renders as a dot.
    line.push(
      `M${coords.join("L")}${coords.length === 1 ? `L${coords[0]}` : ""}`,
    );
    area.push(
      `M${x(first.t)},${base}L${coords.join("L")}L${x(last.t)},${base}Z`,
    );
    segment = [];
  };

  for (const p of visible) {
    const prev = segment[segment.length - 1];
    if (prev && p.t - prev.t > gapMs) flush();
    segment.push(p);
  }
  flush();

  return {
    line: line.join(""),
    area: area.join(""),
    yMax: Number.isFinite(hi) ? hi : 0,
    spanMs,
  };
}
