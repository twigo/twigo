import { describe, it, expect, beforeEach } from "vitest";
import {
  registerStatusSegment,
  getStatusSegments,
  clearStatusSegments,
} from "./statusBar";

function A() {
  return null;
}
function B() {
  return null;
}
function C() {
  return null;
}

describe("status segment registry", () => {
  beforeEach(() => clearStatusSegments());

  it("returns a side's segments ordered by `order`", () => {
    registerStatusSegment({ id: "b", side: "left", order: 2, render: B });
    registerStatusSegment({ id: "a", side: "left", order: 1, render: A });
    registerStatusSegment({ id: "c", side: "right", render: C });
    expect(getStatusSegments("left").map((s) => s.id)).toEqual(["a", "b"]);
    expect(getStatusSegments("right").map((s) => s.id)).toEqual(["c"]);
  });

  it("clears registered segments", () => {
    registerStatusSegment({ id: "a", side: "left", render: A });
    clearStatusSegments();
    expect(getStatusSegments("left")).toEqual([]);
  });
});
