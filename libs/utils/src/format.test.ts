import { describe, it, expect } from "vitest";
import { fmtBytes, fmtRtt, fmtTime, fmtCount, fmtDuration } from "./format";

describe("fmtBytes", () => {
  it("formats B / KB / MB consistently", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(2048)).toBe("2.0 KB");
    expect(fmtBytes(4 * 1024 * 1024)).toBe("4.0 MB");
  });
});

describe("fmtRtt", () => {
  it("formats milliseconds to one decimal", () => {
    expect(fmtRtt(0.42)).toBe("0.4ms");
    expect(fmtRtt(12)).toBe("12.0ms");
  });
});

describe("fmtTime", () => {
  it("renders HH:MM:SS.mmm", () => {
    expect(fmtTime(Date.UTC(2026, 0, 1))).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });
});

describe("fmtCount", () => {
  it("formats compact integer counts", () => {
    expect(fmtCount(999)).toBe("999");
    expect(fmtCount(12_400)).toBe("12.4k");
    expect(fmtCount(3_200_000)).toBe("3.2M");
  });
});

describe("fmtDuration", () => {
  it("humanizes nanosecond durations, 0 = unlimited", () => {
    expect(fmtDuration(0)).toBe("∞");
    expect(fmtDuration(30 * 1e9)).toBe("30s");
    expect(fmtDuration(5 * 60 * 1e9)).toBe("5m");
    expect(fmtDuration(2 * 3600 * 1e9)).toBe("2h");
    expect(fmtDuration(7 * 86_400 * 1e9)).toBe("7d");
  });
});
