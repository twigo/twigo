// Shared display formatters. One implementation each so sizes never disagree
// across panels (a 4 MB message must read the same everywhere).

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, len = 2) => n.toString().padStart(len, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function fmtBytes(n: number): string {
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(1)} TB`;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
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

// Human-readable duration from nanoseconds (0 = unlimited): 0 → "∞",
// 90_000_000_000 → "2m", 604_800_000_000_000 → "7d".
export function fmtDuration(ns: number): string {
  if (ns <= 0) return "∞";
  const s = ns / 1e9;
  if (s < 1) return `${Math.round(ns / 1e6)}ms`;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}
