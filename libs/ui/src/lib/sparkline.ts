export interface SparkPoint {
  t: number;
  v: number;
}

export interface SparkOptions {
  // Ends at the newest point.
  windowMs: number;
  // Past this, a pause in sampling reads as a gap rather than a line across it.
  gapMs: number;
  height: number;
  width?: number;
  pad?: number;
}

export interface SparkGeometry {
  line: string;
  area: string;
  yMax: number;
}

const EMPTY: SparkGeometry = { line: "", area: "", yMax: 0 };

const round = (n: number) => Math.round(n * 100) / 100;

/** SVG paths for a sparkline over `points`, which must be ascending in `t`. */
export function sparkGeometry(
  points: SparkPoint[],
  { windowMs, gapMs, height, width = 100, pad = 1 }: SparkOptions,
): SparkGeometry {
  const end = points[points.length - 1]?.t;
  if (end === undefined || windowMs <= 0) return EMPTY;

  const visible = points.filter((p) => p.t >= end - windowMs);
  let yMax = 0;
  for (const p of visible) if (p.v > yMax) yMax = p.v;

  const base = height - pad;
  const span = height - pad * 2;
  const x = (t: number) => round(width - ((end - t) / windowMs) * width);
  // A flat zero series sits on the baseline rather than dividing by zero.
  const y = (v: number) => round(yMax <= 0 ? base : base - (v / yMax) * span);

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

  return { line: line.join(""), area: area.join(""), yMax };
}
