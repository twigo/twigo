import { describe, it, expect } from "vitest";
import { sparkGeometry } from "./sparkline";

const OPTS = { windowMs: 100, gapMs: 60, height: 10 };

describe("sparkGeometry", () => {
  it("has nothing to draw without points", () => {
    expect(sparkGeometry([], OPTS)).toEqual({ line: "", area: "", yMax: 0 });
  });

  it("anchors the newest sample at the right edge and scales from zero", () => {
    const { line, yMax } = sparkGeometry(
      [
        { t: 900, v: 0 },
        { t: 950, v: 5 },
        { t: 1000, v: 10 },
      ],
      OPTS,
    );

    expect(yMax).toBe(10);
    // x: 0 / 50 / 100 · y: baseline 9, midpoint 5, top 1.
    expect(line).toBe("M0,9L50,5L100,1");
  });

  it("drops samples that fall out of the window", () => {
    const { line } = sparkGeometry(
      [
        { t: 500, v: 99 },
        { t: 950, v: 1 },
        { t: 1000, v: 1 },
      ],
      OPTS,
    );

    expect(line).toBe("M50,1L100,1");
  });

  it("breaks the line across a sampling gap instead of bridging it", () => {
    const { line, area } = sparkGeometry(
      [
        { t: 900, v: 1 },
        { t: 910, v: 1 },
        { t: 990, v: 1 },
        { t: 1000, v: 1 },
      ],
      OPTS,
    );

    expect(line).toBe("M0,1L10,1M90,1L100,1");
    expect(area.match(/Z/g)).toHaveLength(2);
  });

  it("renders a lone sample as a dot", () => {
    expect(sparkGeometry([{ t: 1000, v: 3 }], OPTS).line).toBe("M100,1L100,1");
  });

  it("keeps a flat zero series on the baseline", () => {
    const { line, yMax } = sparkGeometry(
      [
        { t: 950, v: 0 },
        { t: 1000, v: 0 },
      ],
      OPTS,
    );

    expect(yMax).toBe(0);
    expect(line).toBe("M50,9L100,9");
  });
});
