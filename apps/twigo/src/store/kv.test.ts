import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listBuckets: vi.fn(),
  listKeys: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  kvListBuckets: mocks.listBuckets,
  kvListKeys: mocks.listKeys,
}));

import { useKv } from "./kv";

function bucket(name: string) {
  return {
    bucket: name,
    values: 0,
    bytes: 0,
    history: 1,
    maxAge: 0,
    storage: "file",
  };
}
function entry(key: string) {
  return {
    key,
    revision: 1,
    created: null,
    operation: "put",
    delta: 0,
    size: 3,
  };
}

describe("kv store", () => {
  beforeEach(() => {
    mocks.listBuckets.mockReset();
    mocks.listKeys.mockReset();
    useKv.setState({ byConn: {} });
  });

  it("loads buckets for a connection", async () => {
    mocks.listBuckets.mockResolvedValue([bucket("config"), bucket("sessions")]);
    await useKv.getState().load("dev");
    const s = useKv.getState().byConn.dev;
    expect(s?.status).toBe("ready");
    expect(s?.buckets.map((b) => b.bucket)).toEqual(["config", "sessions"]);
  });

  it("records an error status on load failure", async () => {
    mocks.listBuckets.mockRejectedValue(new Error("no JS"));
    await useKv.getState().load("dev");
    expect(useKv.getState().byConn.dev?.status).toBe("error");
  });

  it("lazily loads keys on first expand, and caches them", async () => {
    mocks.listBuckets.mockResolvedValue([bucket("config")]);
    mocks.listKeys.mockResolvedValue([entry("db.host"), entry("db.port")]);
    await useKv.getState().load("dev");

    await useKv.getState().toggleBucket("dev", "config");
    const s = useKv.getState().byConn.dev;
    expect(s?.expanded.config).toBe(true);
    expect(s?.keys.config?.map((k) => k.key)).toEqual(["db.host", "db.port"]);
    expect(mocks.listKeys).toHaveBeenCalledTimes(1);

    // collapse + re-expand: no refetch (cached)
    await useKv.getState().toggleBucket("dev", "config");
    await useKv.getState().toggleBucket("dev", "config");
    expect(mocks.listKeys).toHaveBeenCalledTimes(1);
  });

  it("reset drops a connection's kv state", async () => {
    mocks.listBuckets.mockResolvedValue([bucket("config")]);
    await useKv.getState().load("dev");
    useKv.getState().reset("dev");
    expect(useKv.getState().byConn.dev).toBeUndefined();
  });
});
