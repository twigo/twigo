import { describe, it, expect, beforeEach } from "vitest";
import { useZoom, clampZoom, DEFAULT_ZOOM } from "./zoom";

describe("clampZoom", () => {
  it("keeps values within [0.5, 2] and rounds to a tenth", () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(0.1)).toBe(0.5);
    expect(clampZoom(5)).toBe(2);
    expect(clampZoom(1.04)).toBe(1);
    expect(clampZoom(1.25)).toBeCloseTo(1.3, 5);
  });
});

describe("useZoom", () => {
  beforeEach(() => useZoom.getState().reset());

  it("steps in and out by a tenth", () => {
    useZoom.getState().zoomIn();
    expect(useZoom.getState().factor).toBeCloseTo(1.1, 5);
    useZoom.getState().zoomOut();
    expect(useZoom.getState().factor).toBeCloseTo(1, 5);
  });

  it("clamps at the bounds", () => {
    for (let i = 0; i < 20; i++) useZoom.getState().zoomOut();
    expect(useZoom.getState().factor).toBe(0.5);
    for (let i = 0; i < 40; i++) useZoom.getState().zoomIn();
    expect(useZoom.getState().factor).toBe(2);
  });

  it("reset returns to the default", () => {
    useZoom.getState().zoomIn();
    useZoom.getState().reset();
    expect(useZoom.getState().factor).toBe(DEFAULT_ZOOM);
  });
});
