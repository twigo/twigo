import { describe, it, expect, beforeEach, vi } from "vitest";

const { serviceStats } = vi.hoisted(() => ({ serviceStats: vi.fn() }));
vi.mock("@/lib/api", () => ({ serviceStats }));

import { useServices } from "./services";

describe("useServices.discover", () => {
  beforeEach(() => {
    useServices.setState({ byConn: {} });
    serviceStats.mockReset();
  });

  it("stores discovered services on success", async () => {
    serviceStats.mockResolvedValue([
      { name: "a", id: "1", version: "", started: "", endpoints: [] },
    ]);
    await useServices.getState().discover("c");
    const s = useServices.getState().byConn.c;
    expect(s?.status).toBe("ready");
    expect(s?.services).toHaveLength(1);
  });

  it("drops the write-back if reset() ran mid-discover (no ghost connection)", async () => {
    let resolve!: (v: unknown) => void;
    serviceStats.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const p = useServices.getState().discover("c");
    useServices.getState().reset("c");
    resolve([]);
    await p;
    expect(useServices.getState().byConn.c).toBeUndefined();
  });

  it("records the error on failure", async () => {
    serviceStats.mockRejectedValue(new Error("boom"));
    await useServices.getState().discover("c");
    const s = useServices.getState().byConn.c;
    expect(s?.status).toBe("error");
    expect(s?.error).toContain("boom");
  });
});
