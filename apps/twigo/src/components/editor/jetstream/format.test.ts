import { describe, it, expect } from "vitest";
import { disp, limitCount, limitBytes, supportsPause } from "./format";

describe("jetstream config formatters", () => {
  it("disp renders primitives and falls back for objects", () => {
    expect(disp(null)).toBe("-");
    expect(disp("file")).toBe("file");
    expect(disp("")).toBe("-");
    expect(disp(5)).toBe("5");
    expect(disp(true)).toBe("true");
    expect(disp({ a: 1 })).toBe('{"a":1}');
  });

  it("limitCount/limitBytes show ∞ for -1 (unlimited)", () => {
    expect(limitCount(-1)).toBe("∞");
    expect(limitCount(1500)).toBe("1.5k");
    expect(limitCount("x")).toBe("-");
    expect(limitBytes(-1)).toBe("∞");
    expect(limitBytes(2048)).toBe("2.0 KB");
  });
});

describe("supportsPause", () => {
  it("is true only for NATS 2.11+", () => {
    expect(supportsPause("2.11.0")).toBe(true);
    expect(supportsPause("2.11.5")).toBe(true);
    expect(supportsPause("3.0.0")).toBe(true);
    expect(supportsPause("2.10.9")).toBe(false);
    expect(supportsPause("2.9.0")).toBe(false);
    expect(supportsPause("")).toBe(false);
  });
});
