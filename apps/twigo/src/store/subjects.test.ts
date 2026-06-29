import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  startSubjectWatch: vi.fn().mockResolvedValue(undefined),
  stopSubjectWatch: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/store/workspace", () => ({
  useWorkspace: { getState: () => ({ setWatching: vi.fn() }) },
}));

import { useSubjects } from "./subjects";

describe("useSubjects.update", () => {
  beforeEach(() => useSubjects.setState({ byConn: {}, watching: {} }));

  it("applies stat updates while a watch is active", () => {
    useSubjects.setState({ byConn: {}, watching: { c: ">" } });
    useSubjects.getState().update("c", [], false);
    expect(useSubjects.getState().byConn.c).toEqual({
      stats: [],
      truncated: false,
    });
  });

  it("ignores a late update for a conn with no active watch", () => {
    // A stats event that lands after stopWatch()/reset() must not resurrect it.
    useSubjects.getState().update("c", [], false);
    expect(useSubjects.getState().byConn.c).toBeUndefined();
  });
});
