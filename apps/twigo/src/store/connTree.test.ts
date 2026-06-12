import { describe, it, expect, beforeEach, vi } from "vitest";

const push = vi.fn();
vi.mock("@/store/toasts", () => ({
  useToasts: { getState: () => ({ push }) },
}));

import { createConnTreeStore } from "./connTree";

interface Node {
  id: string;
}

function tree(
  loadParents: () => Promise<Node[]>,
  loadChildren: () => Promise<Node[]>,
  childNoun = "items",
) {
  return createConnTreeStore<Node, Node>({
    loadParents,
    loadChildren,
    childNoun,
  });
}

describe("createConnTreeStore", () => {
  beforeEach(() => push.mockReset());

  it("loads parents and reports a ready status", async () => {
    const useTree = tree(
      () => Promise.resolve([{ id: "p1" }, { id: "p2" }]),
      () => Promise.resolve([]),
    );
    await useTree.getState().load("dev");
    const s = useTree.getState().byConn.dev;
    expect(s?.status).toBe("ready");
    expect(s?.parents.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("records an error status when parents fail to load", async () => {
    const useTree = tree(
      () => Promise.reject(new Error("no")),
      () => Promise.resolve([]),
    );
    await useTree.getState().load("dev");
    expect(useTree.getState().byConn.dev?.status).toBe("error");
  });

  it("lazily loads children on first expand and caches them", async () => {
    const loadChildren = vi.fn(() => Promise.resolve([{ id: "c1" }]));
    const useTree = tree(() => Promise.resolve([{ id: "p1" }]), loadChildren);

    await useTree.getState().toggle("dev", "p1");
    expect(useTree.getState().byConn.dev?.children.p1?.[0]?.id).toBe("c1");
    expect(loadChildren).toHaveBeenCalledTimes(1);

    // collapse then re-expand: no refetch (children are cached)
    await useTree.getState().toggle("dev", "p1");
    await useTree.getState().toggle("dev", "p1");
    expect(loadChildren).toHaveBeenCalledTimes(1);
  });

  it("collapseAll clears every expanded parent", async () => {
    const useTree = tree(
      () => Promise.resolve([]),
      () => Promise.resolve([]),
    );
    await useTree.getState().toggle("dev", "a");
    await useTree.getState().toggle("dev", "b");
    expect(useTree.getState().byConn.dev?.expanded).toEqual({
      a: true,
      b: true,
    });

    useTree.getState().collapseAll("dev");
    expect(useTree.getState().byConn.dev?.expanded).toEqual({});
  });

  it("toasts with the configured noun when children fail to load", async () => {
    const useTree = tree(
      () => Promise.resolve([]),
      () => Promise.reject(new Error("nope")),
      "widgets",
    );
    await useTree.getState().refreshChildren("dev", "p1");

    expect(useTree.getState().byConn.dev?.childrenLoading.p1).toBe(false);
    expect(push).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("Couldn't load widgets for p1"),
    );
  });

  it("reset drops a connection's tree state", async () => {
    const useTree = tree(
      () => Promise.resolve([{ id: "p1" }]),
      () => Promise.resolve([]),
    );
    await useTree.getState().load("dev");
    useTree.getState().reset("dev");
    expect(useTree.getState().byConn.dev).toBeUndefined();
  });
});
