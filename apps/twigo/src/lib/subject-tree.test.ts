import { describe, it, expect } from "vitest";
import { buildSubjectTree } from "./subject-tree";

describe("buildSubjectTree", () => {
  it("nests by token and aggregates count/rate into ancestors", () => {
    const tree = buildSubjectTree([
      { subject: "orders.created", count: 10, rate: 2 },
      { subject: "orders.failed", count: 4, rate: 1 },
    ]);

    expect(tree).toHaveLength(1);
    const orders = tree[0]!;
    expect(orders.token).toBe("orders");
    expect(orders.count).toBe(14);
    expect(orders.rate).toBe(3);
    expect(orders.children.map((c) => c.token)).toEqual(["created", "failed"]);
    expect(orders.children[0]!.path).toBe("orders.created");
  });

  it("sorts siblings alphabetically", () => {
    const tree = buildSubjectTree([
      { subject: "b", count: 1, rate: 0 },
      { subject: "a", count: 1, rate: 0 },
    ]);
    expect(tree.map((n) => n.token)).toEqual(["a", "b"]);
  });

  it("returns an empty array for no stats", () => {
    expect(buildSubjectTree([])).toEqual([]);
  });
});
