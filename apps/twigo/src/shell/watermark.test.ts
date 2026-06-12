import { describe, it, expect, beforeEach } from "vitest";
import { registerWatermark, getWatermark, clearWatermark } from "./watermark";

function Dummy() {
  return null;
}

describe("watermark registry", () => {
  beforeEach(() => clearWatermark());

  it("has no watermark until one is registered", () => {
    expect(getWatermark()).toBeNull();
  });

  it("returns the registered watermark component", () => {
    registerWatermark(Dummy);
    expect(getWatermark()).toBe(Dummy);
  });
});
