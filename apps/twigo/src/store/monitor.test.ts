import { describe, it, expect, beforeEach, vi } from "vitest";

const { monitorVarz, monitorJsz, monitorHealthz } = vi.hoisted(() => ({
  monitorVarz: vi.fn(),
  monitorJsz: vi.fn(),
  monitorHealthz: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ monitorVarz, monitorJsz, monitorHealthz }));

import {
  useMonitor,
  rateSeries,
  rates,
  gaugeSeries,
  TOTAL_MSGS,
  type Sample,
} from "./monitor";

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

function varz(over: Record<string, number> = {}) {
  return {
    inMsgs: 1,
    outMsgs: 2,
    inBytes: 3,
    outBytes: 4,
    connections: 5,
    subscriptions: 8,
    slowConsumers: 0,
    mem: 6,
    cpu: 9,
    ...over,
  };
}

describe("useMonitor.poll", () => {
  beforeEach(() => {
    useMonitor.setState({ byConn: {} });
    monitorVarz.mockReset();
    monitorJsz.mockReset().mockResolvedValue(null);
    monitorHealthz.mockReset().mockResolvedValue(null);
  });

  it("stores a sample on a successful poll", async () => {
    monitorVarz.mockResolvedValue(varz());
    await useMonitor.getState().poll("c", null);
    const s = useMonitor.getState().byConn.c;
    expect(s?.status).toBe("ready");
    expect(s?.samples).toHaveLength(1);
    expect(s?.varz?.inMsgs).toBe(1);
  });

  it("backs off on unavailable and retries after the cooldown", async () => {
    vi.useFakeTimers();
    try {
      monitorVarz.mockRejectedValue(new Error("no responders"));
      await useMonitor.getState().poll("c", null);
      expect(useMonitor.getState().byConn.c?.status).toBe("unavailable");
      expect(monitorVarz).toHaveBeenCalledTimes(1);

      await useMonitor.getState().poll("c", null);
      expect(monitorVarz).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 31_000);
      monitorVarz.mockResolvedValue(varz());
      await useMonitor.getState().poll("c", null);
      expect(monitorVarz).toHaveBeenCalledTimes(2);
      expect(useMonitor.getState().byConn.c?.status).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips a poll that lands inside the minimum sample spacing", async () => {
    vi.useFakeTimers();
    try {
      monitorVarz.mockResolvedValue(varz());
      await useMonitor.getState().poll("c", null, 2000);
      vi.setSystemTime(Date.now() + 500);
      await useMonitor.getState().poll("c", null, 2000);
      expect(monitorVarz).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 2000);
      await useMonitor.getState().poll("c", null, 2000);
      expect(monitorVarz).toHaveBeenCalledTimes(2);
      expect(useMonitor.getState().byConn.c?.samples).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an hour of samples and drops what falls out of it", async () => {
    vi.useFakeTimers();
    try {
      monitorVarz.mockResolvedValue(varz());
      await useMonitor.getState().poll("c", null);
      const first = useMonitor.getState().byConn.c?.samples[0]?.t;

      vi.setSystemTime(Date.now() + 59 * 60_000);
      await useMonitor.getState().poll("c", null);
      expect(useMonitor.getState().byConn.c?.samples).toHaveLength(2);
      expect(useMonitor.getState().byConn.c?.samples[0]?.t).toBe(first);

      vi.setSystemTime(Date.now() + 2 * 60_000);
      await useMonitor.getState().poll("c", null);
      const kept = useMonitor.getState().byConn.c?.samples ?? [];
      expect(kept).toHaveLength(2);
      expect(kept[0]?.t).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the write-back if reset() ran mid-poll (no ghost connection)", async () => {
    let resolve!: (v: unknown) => void;
    monitorVarz.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const p = useMonitor.getState().poll("c", null);
    useMonitor.getState().reset("c"); // disconnect while the poll is in flight
    resolve(varz());
    await p;
    expect(useMonitor.getState().byConn.c).toBeUndefined();
  });
});

describe("series", () => {
  it("turns cumulative counters into per-second rates", () => {
    const s = [
      sample(0, { inMsgs: 100 }),
      sample(2000, { inMsgs: 300 }),
      sample(4000, { inMsgs: 300 }),
    ];
    expect(rateSeries(s, TOTAL_MSGS)).toEqual([
      { t: 2000, v: 100 },
      { t: 4000, v: 0 },
    ]);
  });

  it("skips a counter reset rather than charting a negative spike", () => {
    const s = [
      sample(0, { inMsgs: 500 }),
      sample(1000, { inMsgs: 4 }), // server restarted
      sample(2000, { inMsgs: 14 }),
    ];
    expect(rateSeries(s, TOTAL_MSGS)).toEqual([{ t: 2000, v: 10 }]);
    expect(rates(s.slice(0, 2))).toBeNull();
  });

  it("needs two samples before there is a rate", () => {
    expect(rateSeries([sample(0)], TOTAL_MSGS)).toEqual([]);
    expect(rates([sample(0)])).toBeNull();
  });

  it("reads gauges straight off the samples", () => {
    expect(gaugeSeries([sample(0, { mem: 7 })], (x) => x.mem)).toEqual([
      { t: 0, v: 7 },
    ]);
  });
});
