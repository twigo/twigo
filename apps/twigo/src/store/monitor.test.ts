import { describe, it, expect, beforeEach, vi } from "vitest";

const { monitorVarz, monitorJsz, monitorHealthz } = vi.hoisted(() => ({
  monitorVarz: vi.fn(),
  monitorJsz: vi.fn(),
  monitorHealthz: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ monitorVarz, monitorJsz, monitorHealthz }));

import { useMonitor } from "./monitor";

function varz(over: Record<string, number> = {}) {
  return {
    inMsgs: 1,
    outMsgs: 2,
    inBytes: 3,
    outBytes: 4,
    connections: 5,
    slowConsumers: 0,
    mem: 6,
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
