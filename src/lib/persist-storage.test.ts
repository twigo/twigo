import { describe, it, expect, beforeEach } from "vitest";
import { createPersistStorage } from "./persist-storage";

// In jsdom there is no Tauri, so the adapter uses the localStorage path.
describe("persist storage (defensive parse)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips a value", async () => {
    const storage = createPersistStorage<{ a: number }>();
    await storage.setItem("k", { state: { a: 1 }, version: 1 });
    expect(await storage.getItem("k")).toEqual({ state: { a: 1 }, version: 1 });
  });

  it("returns null for a missing key", async () => {
    const storage = createPersistStorage();
    expect(await storage.getItem("missing")).toBeNull();
  });

  it("returns null (not throw) for corrupt JSON so hydration can't hang", async () => {
    localStorage.setItem("bad", "{not json");
    const storage = createPersistStorage();
    await expect(storage.getItem("bad")).resolves.toBeNull();
  });
});
