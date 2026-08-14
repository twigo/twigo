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

  it("ranks siblings by rate, busiest first", () => {
    const tree = buildSubjectTree(
      [
        { subject: "a", count: 1, rate: 1 },
        { subject: "b", count: 1, rate: 9 },
        { subject: "c", count: 1, rate: 5 },
      ],
      "rate",
    );
    expect(tree.map((n) => n.token)).toEqual(["b", "c", "a"]);
  });

  it("ranks siblings by message count", () => {
    const tree = buildSubjectTree(
      [
        { subject: "a", count: 3, rate: 0 },
        { subject: "b", count: 90, rate: 0 },
      ],
      "count",
    );
    expect(tree.map((n) => n.token)).toEqual(["b", "a"]);
  });

  it("keeps alphabetical order as the tiebreak so equal rows never shuffle", () => {
    const tree = buildSubjectTree(
      [
        { subject: "z", count: 0, rate: 0 },
        { subject: "m", count: 0, rate: 0 },
        { subject: "a", count: 0, rate: 0 },
      ],
      "rate",
    );
    expect(tree.map((n) => n.token)).toEqual(["a", "m", "z"]);
  });

  it("ranks every level, so the busiest branch leads to the busiest leaf", () => {
    const tree = buildSubjectTree(
      [
        { subject: "quiet.a", count: 1, rate: 1 },
        { subject: "busy.slow", count: 1, rate: 2 },
        { subject: "busy.fast", count: 1, rate: 8 },
      ],
      "rate",
    );
    expect(tree.map((n) => n.token)).toEqual(["busy", "quiet"]);
    expect(tree[0]!.children.map((n) => n.token)).toEqual(["fast", "slow"]);
  });

  it("sorts alphabetically by default, so other callers are unaffected", () => {
    const tree = buildSubjectTree([
      { subject: "b", count: 1, rate: 99 },
      { subject: "a", count: 1, rate: 0 },
    ]);
    expect(tree.map((n) => n.token)).toEqual(["a", "b"]);
  });
});
