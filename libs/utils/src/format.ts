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
