import { describe, it, expect } from "vitest";
import { pointAt, fractionOf, peak, windowMsOf, CHARTS } from "./metrics";
import type { Sample } from "@/store/monitor";

const POINTS = [
  { t: 0, v: 1 },
  { t: 500, v: 9 },
  { t: 1000, v: 3 },
];

function sample(t: number, over: Partial<Sample> = {}): Sample {
  return {
    t,
    inMsgs: 0,
    outMsgs: 0,
    inBytes: 0,
    outBytes: 0,
    connections: 0,
    subscriptions: 0,
    slowConsumers: 0,
    mem: 0,
    cpu: 0,
    ...over,
  };
}

describe("pointAt", () => {
  it("picks the sample nearest the pointer", () => {
    expect(pointAt(POINTS, 1, 1000)).toEqual({ t: 1000, v: 3 });
    expect(pointAt(POINTS, 0.5, 1000)).toEqual({ t: 500, v: 9 });
    expect(pointAt(POINTS, 0, 1000)).toEqual({ t: 0, v: 1 });
    // Between two samples, the closer one wins.
    expect(pointAt(POINTS, 0.4, 1000)).toEqual({ t: 500, v: 9 });
  });

  it("has nothing to point at without samples", () => {
    expect(pointAt([], 0.5, 1000)).toBeNull();
  });
});

describe("fractionOf", () => {
  it("places a sample across the window", () => {
    expect(fractionOf({ t: 1000, v: 0 }, POINTS, 1000)).toBe(1);
    expect(fractionOf({ t: 500, v: 0 }, POINTS, 1000)).toBe(0.5);
  });

  it("clamps a sample older than the window to the left edge", () => {
    expect(fractionOf({ t: -5000, v: 0 }, POINTS, 1000)).toBe(0);
  });
});

describe("peak", () => {
  it("is the highest value, and zero when there is nothing", () => {
    expect(peak(POINTS)).toBe(9);
    expect(peak([])).toBe(0);
  });
});

describe("windowMsOf", () => {
  it("resolves each offered window", () => {
    expect(windowMsOf("5m")).toBe(300_000);
    expect(windowMsOf("15m")).toBe(900_000);
    expect(windowMsOf("1h")).toBe(3_600_000);
  });
});

describe("CHARTS", () => {
  it("derives rates from counters and gauges straight from the samples", () => {
    const samples = [
      sample(0, { inMsgs: 0, mem: 100 }),
      sample(1000, { inMsgs: 50, mem: 200 }),
    ];
    const byId = Object.fromEntries(CHARTS.map((c) => [c.id, c]));

    expect(byId.throughput?.series(samples)).toEqual([{ t: 1000, v: 50 }]);
    expect(byId.memory?.series(samples)).toEqual([
      { t: 0, v: 100 },
      { t: 1000, v: 200 },
    ]);
    expect(byId.cpu?.format(12.4)).toBe("12%");
  });
});
