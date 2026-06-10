import { describe, it, expect, beforeEach } from "vitest";
import { useWorkspace } from "./workspace";

describe("workspace per-context layouts", () => {
  beforeEach(() => {
    useWorkspace.setState({ layouts: {}, activeContext: null });
  });

  it("stores a separate layout per connection", () => {
    const a = { tag: "a" } as never;
    const b = { tag: "b" } as never;
    useWorkspace.getState().setLayout("conn-a", a);
    useWorkspace.getState().setLayout("conn-b", b);
    expect(useWorkspace.getState().layouts["conn-a"]).toBe(a);
    expect(useWorkspace.getState().layouts["conn-b"]).toBe(b);
  });

  it("overwrites only the given connection's layout", () => {
    useWorkspace.getState().setLayout("conn-a", { v: 1 } as never);
    useWorkspace.getState().setLayout("conn-b", { v: 2 } as never);
    useWorkspace.getState().setLayout("conn-a", { v: 3 } as never);
    expect(useWorkspace.getState().layouts["conn-a"]).toEqual({ v: 3 });
    expect(useWorkspace.getState().layouts["conn-b"]).toEqual({ v: 2 });
  });

  it("remembers the active context", () => {
    useWorkspace.getState().setActiveContext("prod-eu");
    expect(useWorkspace.getState().activeContext).toBe("prod-eu");
  });

  it("prunes state for connections that no longer exist", () => {
    useWorkspace.setState({
      layouts: { "": {} as never, a: {} as never, gone: {} as never },
      watching: { a: ">", gone: "x.>" },
      lastConnected: ["a", "gone"],
      activeContext: "gone",
    });
    useWorkspace.getState().prune(["a"]);
    const s = useWorkspace.getState();
    expect(Object.keys(s.layouts).sort()).toEqual(["", "a"]);
    expect(s.watching).toEqual({ a: ">" });
    expect(s.lastConnected).toEqual(["a"]);
    expect(s.activeContext).toBeNull();
  });
});
