import { expect, test, vi } from "vitest";
import { srgbHex } from "./srgb";

const painted = new Map([
  ["oklch(0.3 0.02 250)", [16, 24, 32, 255]],
  ["oklch(0.3 0.02 250 / 50%)", [16, 24, 32, 128]],
]);

vi.stubGlobal(
  "OffscreenCanvas",
  class {
    getContext() {
      return {
        fillStyle: "",
        clearRect: () => undefined,
        fillRect: () => undefined,
        getImageData(this: { fillStyle: string }) {
          return {
            data: Uint8ClampedArray.from(painted.get(this.fillStyle) ?? []),
          };
        },
      };
    }
  },
);

test("an opaque colour reads back as #rrggbb", () => {
  expect(srgbHex("oklch(0.3 0.02 250)")).toBe("#101820");
});

test("a translucent colour keeps its alpha as #rrggbbaa", () => {
  expect(srgbHex("oklch(0.3 0.02 250 / 50%)")).toBe("#10182080");
});
