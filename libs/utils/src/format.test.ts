import { describe, it, expect } from "vitest";
import {
  fmtBytes,
  fmtRtt,
  fmtTime,
  fmtCount,
  fmtDuration,
  fmtDateTime,
  fmtRelTime,
  fmtIsoDateTime,
} from "./format";

describe("fmtBytes", () => {
  it("formats B / KB / MB / GB / TB consistently", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(2048)).toBe("2.0 KB");
    expect(fmtBytes(4 * 1024 * 1024)).toBe("4.0 MB");
    expect(fmtBytes(3 * 1024 ** 3)).toBe("3.0 GB");
    expect(fmtBytes(2 * 1024 ** 4)).toBe("2.0 TB");
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

describe("fmtDateTime", () => {
  it("renders YYYY-MM-DD HH:MM:SS.mmm", () => {
    expect(fmtDateTime(Date.UTC(2026, 5, 12, 10, 0, 0))).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/,
    );
  });
});

describe("fmtRelTime", () => {
  const now = 1_000_000_000_000;
  it("describes recent times relative to now", () => {
    expect(fmtRelTime(now, now)).toBe("just now");
    expect(fmtRelTime(now - 12_000, now)).toBe("12s ago");
    expect(fmtRelTime(now - 3 * 60_000, now)).toBe("3m ago");
    expect(fmtRelTime(now - 2 * 3_600_000, now)).toBe("2h ago");
    expect(fmtRelTime(now - 5 * 86_400_000, now)).toBe("5d ago");
  });
  it("never goes negative for a future timestamp", () => {
    expect(fmtRelTime(now + 5_000, now)).toBe("just now");
  });
});

describe("fmtIsoDateTime", () => {
  it("formats a parseable ISO timestamp", () => {
    expect(fmtIsoDateTime("2026-06-12T10:00:00Z")).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/,
    );
  });
  it("falls back to the raw string when unparseable", () => {
    expect(fmtIsoDateTime("not-a-date")).toBe("not-a-date");
  });
});
