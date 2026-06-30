import { describe, it, expect } from "vitest";
import type { ServiceStats } from "@/lib/api";
import type { ServiceInfo } from "@/lib/api";
import {
  aggregate,
  sortServices,
  matchesServiceFilter,
  mergeEndpoints,
} from "./serviceStats";

function svc(over: Partial<ServiceStats> = {}): ServiceStats {
  return {
    name: "svc",
    id: "id",
    version: "1.0.0",
    started: "2024-01-01T00:00:00Z",
    endpoints: [],
    ...over,
  };
}

function endpoint(over: Partial<ServiceStats["endpoints"][number]> = {}) {
  return {
    name: "ep",
    subject: "svc.ep",
    numRequests: 0,
    numErrors: 0,
    processingTime: 0,
    averageProcessingTime: 0,
    lastError: "",
    queueGroup: "",
    ...over,
  };
}

describe("aggregate", () => {
  it("sums endpoint requests/errors and weights the mean processing time", () => {
    const s = svc({
      endpoints: [
        endpoint({ numRequests: 10, numErrors: 1, processingTime: 1000 }),
        endpoint({ numRequests: 30, numErrors: 2, processingTime: 3000 }),
      ],
    });
    const a = aggregate(s, Date.parse("2024-01-01T00:00:10Z"));
    expect(a.requests).toBe(40);
    expect(a.errors).toBe(3);
    expect(a.avgProcessingNs).toBe(100); // 4000ns / 40 requests
    expect(a.uptimeMs).toBe(10_000);
  });

  it("reports zero mean with no requests and null uptime when unparseable", () => {
    const a = aggregate(svc({ started: "nope", endpoints: [endpoint()] }));
    expect(a.avgProcessingNs).toBe(0);
    expect(a.uptimeMs).toBeNull();
  });
});

describe("sortServices", () => {
  const a = svc({
    name: "a",
    id: "1",
    endpoints: [endpoint({ numRequests: 5 })],
  });
  const b = svc({
    name: "b",
    id: "2",
    endpoints: [endpoint({ numRequests: 50 })],
  });

  it("sorts by a metric column respecting direction", () => {
    expect(sortServices([a, b], "requests", "desc").map((s) => s.name)).toEqual(
      ["b", "a"],
    );
    expect(sortServices([b, a], "requests", "asc").map((s) => s.name)).toEqual([
      "a",
      "b",
    ]);
  });

  it("breaks ties (and sorts 'name') by name then id", () => {
    const a2 = svc({ name: "a", id: "2", endpoints: [endpoint()] });
    const a1 = svc({ name: "a", id: "1", endpoints: [endpoint()] });
    expect(sortServices([a2, a1], "name", "asc").map((s) => s.id)).toEqual([
      "1",
      "2",
    ]);
  });
});

describe("mergeEndpoints", () => {
  it("joins stats with info by endpoint name, info filling metadata/queue", () => {
    const stats = svc({
      endpoints: [
        endpoint({ name: "add", subject: "calc.add", numRequests: 7 }),
      ],
    });
    const info: ServiceInfo = {
      name: "svc",
      id: "id",
      version: "1.0.0",
      description: "d",
      metadata: {},
      endpoints: [
        {
          name: "add",
          subject: "calc.add",
          queueGroup: "q",
          metadata: { k: "v" },
        },
      ],
    };
    const [m] = mergeEndpoints(stats, info);
    expect(m?.numRequests).toBe(7);
    expect(m?.queueGroup).toBe("q");
    expect(m?.metadata).toEqual({ k: "v" });
  });

  it("works with no info (stats-only)", () => {
    const stats = svc({ endpoints: [endpoint({ name: "x", subject: "a.x" })] });
    const [m] = mergeEndpoints(stats, undefined);
    expect(m?.subject).toBe("a.x");
    expect(m?.metadata).toEqual({});
  });
});

describe("matchesServiceFilter", () => {
  const s = svc({
    name: "billing",
    id: "abc",
    endpoints: [endpoint({ subject: "pay.charge" })],
  });

  it("matches name, id, and endpoint subject; empty filter matches all", () => {
    expect(matchesServiceFilter(s, "")).toBe(true);
    expect(matchesServiceFilter(s, "bill")).toBe(true);
    expect(matchesServiceFilter(s, "abc")).toBe(true);
    expect(matchesServiceFilter(s, "pay.charge")).toBe(true);
    expect(matchesServiceFilter(s, "orders")).toBe(false);
  });
});
