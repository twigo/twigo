import { describe, it, expect } from "vitest";
import { messageMatches } from "./messageFilter";

describe("messageMatches", () => {
  it("matches everything for an empty filter", () => {
    expect(messageMatches("orders.new", "hi", "")).toBe(true);
    expect(messageMatches("orders.new", "hi", "   ")).toBe(true);
  });

  it("matches on subject or payload preview, case-insensitively", () => {
    expect(messageMatches("orders.NEW", "x", "new")).toBe(true);
    expect(messageMatches("audit", "User Logged IN", "logged")).toBe(true);
    expect(messageMatches("orders", "hello", "zzz")).toBe(false);
  });
});
