/** The font an element's text is set in, as the canvas takes it. */
export interface Font {
  readonly css: string;
  readonly size: number;
}

const fonts = new Map<string, Font>();
let canvas: OffscreenCanvasRenderingContext2D | undefined;
let set = "";

/**
 * The font of an element's text, from its computed style, which asks the
 * engine for no layout. A font read before is the same object, so a part
 * can tell by identity that its font did not change. None for an element
 * outside the document, whose computed style is empty: a width in em of it
 * would be no number.
 */
export function fontOf(element: Element): Font | undefined {
  const style = getComputedStyle(element);
  const size = parseFloat(style.fontSize);
  if (!Number.isFinite(size)) return undefined;
  const css = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  let font = fonts.get(css);
  if (!font) {
    font = { css, size };
    fonts.set(css, font);
  }
  return font;
}

/**
 * How wide `text` sets in `font`, in em, measured on a canvas: it reads no
 * layout, so a row can ask for its own text. The font's own size is measured
 * at, since the system font's spacing changes with its size.
 */
export function emWidth(text: string, font: Font): number {
  canvas ??= context();
  if (set !== font.css) {
    canvas.font = font.css;
    set = font.css;
  }
  return canvas.measureText(text).width / font.size;
}

function context(): OffscreenCanvasRenderingContext2D {
  const made = new OffscreenCanvas(1, 1).getContext("2d");
  if (made === null) throw new Error("no 2D canvas to measure text with");
  return made;
}
