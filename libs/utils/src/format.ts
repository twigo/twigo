// Shared display formatters. One implementation each so sizes never disagree
// across panels (a 4 MB message must read the same everywhere).

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, len = 2) => n.toString().padStart(len, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n.toString()} B`;
}

export function fmtRtt(ms: number): string {
  return `${ms.toFixed(1)}ms`;
}

// Compact integer count: 999 → "999", 12_400 → "12.4k", 3_200_000 → "3.2M".
export function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}
