import { describe, it, expect } from "vitest";
import { diffPayload } from "./diff";

describe("diffPayload", () => {
  it("marks unchanged, removed and added lines", () => {
    const lines = diffPayload("a\nb\nc", "a\nx\nc");
    const tagged = lines.map((l) => `${l.type}:${l.text}`);
    expect(tagged).toContain("ctx:a");
    expect(tagged).toContain("del:b");
    expect(tagged).toContain("add:x");
    expect(tagged).toContain("ctx:c");
  });

  it("returns only context lines for identical payloads", () => {
    const lines = diffPayload("x\ny", "x\ny");
    expect(lines.every((l) => l.type === "ctx")).toBe(true);
    expect(lines.map((l) => l.text)).toEqual(["x", "y"]);
  });
});
