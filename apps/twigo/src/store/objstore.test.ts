import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listBuckets: vi.fn(),
  listObjects: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  objListBuckets: mocks.listBuckets,
  objListObjects: mocks.listObjects,
}));

import { useObjStore } from "./objstore";

function bucket(name: string) {
  return { bucket: name, bytes: 0, storage: "file" };
}
function object(name: string) {
  return { name, size: 10, chunks: 1, modified: null, deleted: false };
}

describe("objstore store", () => {
  beforeEach(() => {
    mocks.listBuckets.mockReset();
    mocks.listObjects.mockReset();
    useObjStore.setState({ byConn: {} });
  });

  it("loads object-store buckets", async () => {
    mocks.listBuckets.mockResolvedValue([bucket("assets"), bucket("backups")]);
    await useObjStore.getState().load("dev");
    const s = useObjStore.getState().byConn.dev;
    expect(s?.status).toBe("ready");
    expect(s?.parents.map((b) => b.bucket)).toEqual(["assets", "backups"]);
  });

  it("lazily loads objects on first expand, and caches them", async () => {
    mocks.listBuckets.mockResolvedValue([bucket("assets")]);
    mocks.listObjects.mockResolvedValue([
      object("logo.png"),
      object("doc.pdf"),
    ]);
    await useObjStore.getState().load("dev");

    await useObjStore.getState().toggle("dev", "assets");
    const s = useObjStore.getState().byConn.dev;
    expect(s?.expanded.assets).toBe(true);
    expect(s?.children.assets?.map((o) => o.name)).toEqual([
      "logo.png",
      "doc.pdf",
    ]);
    expect(mocks.listObjects).toHaveBeenCalledTimes(1);

    await useObjStore.getState().toggle("dev", "assets");
    await useObjStore.getState().toggle("dev", "assets");
    expect(mocks.listObjects).toHaveBeenCalledTimes(1);
  });

  it("reset drops a connection's object-store state", async () => {
    mocks.listBuckets.mockResolvedValue([bucket("assets")]);
    await useObjStore.getState().load("dev");
    useObjStore.getState().reset("dev");
    expect(useObjStore.getState().byConn.dev).toBeUndefined();
  });
});
