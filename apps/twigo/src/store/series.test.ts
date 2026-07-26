import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSeries } from "./series";

describe("useSeries", () => {
  beforeEach(() => useSeries.setState({ byConn: {} }));

  it("appends a stamped point per push, per key", () => {
    vi.useFakeTimers();
    try {
      const push = useSeries.getState().push;
      vi.setSystemTime(1000);
      push("c", "lag", 5);
      vi.setSystemTime(2000);
      push("c", "lag", 7);
      push("c", "other", 1);

      expect(useSeries.getState().byConn.c?.lag).toEqual([
        { t: 1000, v: 5 },
        { t: 2000, v: 7 },
      ]);
      expect(useSeries.getState().byConn.c?.other).toEqual([{ t: 2000, v: 1 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops points older than the retention window", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      useSeries.getState().push("c", "lag", 1);
      vi.setSystemTime(31 * 60_000);
      useSeries.getState().push("c", "lag", 2);

      expect(useSeries.getState().byConn.c?.lag).toEqual([
        { t: 31 * 60_000, v: 2 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a connection's series on reset, leaving others alone", () => {
    useSeries.getState().push("gone", "lag", 1);
    useSeries.getState().push("kept", "lag", 1);

    useSeries.getState().reset("gone");

    expect(useSeries.getState().byConn.gone).toBeUndefined();
    expect(useSeries.getState().byConn.kept?.lag).toHaveLength(1);
  });
});
