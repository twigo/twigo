import type { ServiceStats } from "@/lib/api";

export interface ServiceAggregate {
  requests: number;
  errors: number;
  // Weighted mean processing time across endpoints, in nanoseconds.
  avgProcessingNs: number;
  // null when the started timestamp is missing/unparseable.
  uptimeMs: number | null;
}

export function aggregate(
  s: ServiceStats,
  now: number = Date.now(),
): ServiceAggregate {
  let requests = 0;
  let errors = 0;
  let totalNs = 0;
  for (const e of s.endpoints) {
    requests += e.numRequests;
    errors += e.numErrors;
    totalNs += e.processingTime;
  }
  const startedMs = Date.parse(s.started);
  return {
    requests,
    errors,
    avgProcessingNs: requests > 0 ? totalNs / requests : 0,
    uptimeMs: Number.isNaN(startedMs) ? null : Math.max(0, now - startedMs),
  };
}

export type ServiceSortKey = "name" | "requests" | "errors" | "avg" | "uptime";
export type SortDir = "asc" | "desc";

// Sort instances by an aggregate column. `name` is the stable tiebreaker so the
// order is deterministic across refreshes.
export function sortServices(
  services: ServiceStats[],
  key: ServiceSortKey,
  dir: SortDir,
  now: number = Date.now(),
): ServiceStats[] {
  const sign = dir === "asc" ? 1 : -1;
  return services
    .map((s) => ({ s, a: aggregate(s, now) }))
    .sort((x, y) => {
      let cmp = 0;
      switch (key) {
        case "name":
          cmp = 0;
          break;
        case "requests":
          cmp = x.a.requests - y.a.requests;
          break;
        case "errors":
          cmp = x.a.errors - y.a.errors;
          break;
        case "avg":
          cmp = x.a.avgProcessingNs - y.a.avgProcessingNs;
          break;
        case "uptime":
          cmp = (x.a.uptimeMs ?? 0) - (y.a.uptimeMs ?? 0);
          break;
      }
      if (cmp !== 0) return cmp * sign;
      const byName =
        x.s.name.localeCompare(y.s.name) || x.s.id.localeCompare(y.s.id);
      return key === "name" ? byName * sign : byName;
    })
    .map((r) => r.s);
}

// Match a service against a free-text filter by name, id, or any endpoint subject.
export function matchesServiceFilter(s: ServiceStats, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  if (s.name.toLowerCase().includes(f) || s.id.toLowerCase().includes(f)) {
    return true;
  }
  return s.endpoints.some(
    (e) =>
      e.subject.toLowerCase().includes(f) || e.name.toLowerCase().includes(f),
  );
}
