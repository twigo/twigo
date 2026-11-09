let canvas: OffscreenCanvasRenderingContext2D | undefined;

/**
 * A CSS colour, such as a token's `oklch`, in sRGB hex as the engine draws
 * it: `#rrggbb`, or `#rrggbbaa` when it is not opaque.
 */
export function srgbHex(colour: string): string {
  canvas ??= context();
  canvas.clearRect(0, 0, 1, 1);
  canvas.fillStyle = colour;
  canvas.fillRect(0, 0, 1, 1);
  const pixel = canvas.getImageData(0, 0, 1, 1).data;
  const channels = pixel[3] === 255 ? pixel.subarray(0, 3) : pixel;
  return `#${Array.from(channels, (n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function context(): OffscreenCanvasRenderingContext2D {
  const made = new OffscreenCanvas(1, 1).getContext("2d", {
    willReadFrequently: true,
  });
  if (made === null) throw new Error("no 2D canvas to read colours with");
  return made;
}
