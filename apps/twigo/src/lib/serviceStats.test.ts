import { describe, it, expect } from "vitest";
import type { ServiceStats } from "@/lib/api";
import { aggregate, sortServices, matchesServiceFilter } from "./serviceStats";

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
