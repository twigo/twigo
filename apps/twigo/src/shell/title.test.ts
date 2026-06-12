import { describe, it, expect } from "vitest";
import { composeTitle } from "./title";

describe("composeTitle", () => {
  it("is the bare base name without a suffix", () => {
    expect(composeTitle()).toBe("Twigo");
    expect(composeTitle(null)).toBe("Twigo");
    expect(composeTitle("")).toBe("Twigo");
    expect(composeTitle("   ")).toBe("Twigo");
  });

  it("appends a trimmed suffix", () => {
    expect(composeTitle("prod-eu")).toBe("Twigo - prod-eu");
    expect(composeTitle("  local  ")).toBe("Twigo - local");
  });
});
