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

// Absolute local date + time, ISO-like and sortable: "2026-06-12 23:24:01.123".
// The full form for tooltips and inspectors (fmtTime is the compact table form).
export function fmtDateTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, len = 2) => n.toString().padStart(len, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// Relative time for the recent window: "just now", "12s ago", "3m ago",
// "2h ago", "5d ago". `now` is a parameter so the result is pure/testable.
export function fmtRelTime(ms: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 1) return "just now";
  if (s < 60) return `${s.toString()}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m.toString()}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h.toString()}h ago`;
  return `${Math.round(h / 24).toString()}d ago`;
}

// Format a server ISO timestamp (e.g. a stored JetStream message time) for
// display, falling back to the raw string if it isn't parseable.
export function fmtIsoDateTime(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : fmtDateTime(ms);
}

// Compact integer count: 999 → "999", 12_400 → "12.4k", 3_200_000 → "3.2M".
export function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

// Latency from nanoseconds, where 0 means "none" (not unlimited): 0 → "0",
// 500 → "500ns", 1_500 → "1.5µs", 2_500_000 → "2.5ms", 3_000_000_000 → "3.0s".
export function fmtLatency(ns: number): string {
  if (ns <= 0) return "0";
  if (ns < 1_000) return `${Math.round(ns).toString()}ns`;
  if (ns < 1_000_000) return `${(ns / 1_000).toFixed(1)}µs`;
  if (ns < 1_000_000_000) return `${(ns / 1_000_000).toFixed(1)}ms`;
  return `${(ns / 1_000_000_000).toFixed(1)}s`;
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
