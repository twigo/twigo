import { describe, it, expect } from "vitest";
import { computeUnread } from "./MessageStream";

const rows = (ids: number[]) => ids.map((id) => ({ id }));

describe("computeUnread", () => {
  it("is zero while pinned to the bottom", () => {
    expect(computeUnread(true, false, rows([1, 2, 3]), 3, 0)).toBe(0);
  });

  it("counts new messages by id delta when no filter is active", () => {
    // last seen id 4, full stream now at 8 -> 4 new
    expect(computeUnread(false, false, rows([5, 6, 7, 8]), 8, 4)).toBe(4);
  });

  it("counts only matching rows newer than last seen when a filter is active", () => {
    // the stream advanced 4 -> 8 but only ids 6 and 8 match the filter, so the
    // badge is 2 (the visible new rows), not the 4-id delta.
    expect(computeUnread(false, true, rows([6, 8]), 8, 4)).toBe(2);
  });

  it("never goes negative", () => {
    expect(computeUnread(false, false, rows([]), 2, 5)).toBe(0);
  });
});
