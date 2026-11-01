import type { GroupCount, Gvr } from "@twigo/protocol";
import { cellTone, type Tone } from "./tones";

/** A row's health by its status column: healthy, or the tone of an abnormal state. */
export type Health = "ok" | Tone;

export const HEALTH: Readonly<
  Record<Health, { dot: string; name: string; title: string }>
> = {
  ok: { dot: "bg-ok", name: "healthy", title: "Healthy" },
  warn: { dot: "bg-warn", name: "pending", title: "Pending" },
  error: { dot: "bg-error", name: "failing", title: "Failing" },
};

export interface HealthCount {
  readonly health: Health;
  readonly count: number;
  readonly values: readonly GroupCount[];
}

/** The status column's values by health, each with its rows. */
export function byHealth(
  gvr: Gvr,
  column: string,
  groups: readonly GroupCount[],
): Readonly<Record<Health, HealthCount>> {
  const counts: Record<Health, HealthCount> = {
    ok: { health: "ok", count: 0, values: [] },
    warn: { health: "warn", count: 0, values: [] },
    error: { health: "error", count: 0, values: [] },
  };
  for (const group of groups) {
    const health = cellTone(gvr, column, group.value) ?? "ok";
    const current = counts[health];
    counts[health] = {
      health,
      count: current.count + group.count,
      values: [...current.values, group],
    };
  }
  return counts;
}

/** A health's values, sorted, so counts that swap keep the list's query. */
export function healthValues(count: HealthCount): string[] {
  return count.values.map((group) => group.value).sort();
}
