import { fmtBytes, fmtCount } from "@twigo/utils";

// JetStream config values arrive as wire JSON (`unknown`); these render them
// safely for the detail panels.

export function disp(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v || "—";
  if (
    typeof v === "number" ||
    typeof v === "boolean" ||
    typeof v === "bigint"
  ) {
    return String(v);
  }
  return JSON.stringify(v);
}

export function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

export function limitCount(v: unknown): string {
  const n = num(v);
  if (n === null) return "—";
  return n < 0 ? "∞" : fmtCount(n);
}

export function limitBytes(v: unknown): string {
  const n = num(v);
  if (n === null) return "—";
  return n < 0 ? "∞" : fmtBytes(n);
}
