import { srgbHex } from "@twigo/ui";
import type { ITheme } from "@xterm/xterm";

const ANSI = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
] as const;

const bright = (name: string) =>
  `bright${name.charAt(0).toUpperCase()}${name.slice(1)}`;

/**
 * xterm's theme from the tokens (ARCHITECTURE 4.9): the editor's surface,
 * opaque as the WebGL renderer needs, its text, and the sixteen colours the
 * logs use. A token that is not set leaves xterm's own colour for the slot.
 * @todo: pass the tokens as they are, not in sRGB hex, once xterm's WebGL
 * addon reads a pattern glyph's colour from any CSS colour: it parses only
 * hex and `rgba()` when it draws one such as ░, and throws on `oklch`, which
 * leaves the rows below undrawn ([`drawPatternChar`](https://github.com/xtermjs/xterm.js/blob/f70764dd3da05ebda0390605c6f9adbbea3f0e90/addons/addon-webgl/src/customGlyphs/CustomGlyphRasterizer.ts#L495-L504)).
 */
export function terminalTheme(
  root: Element = document.documentElement,
): ITheme {
  const style = getComputedStyle(root);
  const slots: readonly (readonly [string, string])[] = [
    ["background", "editor"],
    ["foreground", "foreground"],
    ["cursor", "foreground"],
    ["cursorAccent", "editor"],
    ["selectionBackground", "brand"],
    ...ANSI.flatMap((name) => [
      [name, `ansi-${name}`] as const,
      [bright(name), `ansi-bright-${name}`] as const,
    ]),
  ];
  return Object.fromEntries(
    slots.flatMap(([slot, token]) => {
      const value = style.getPropertyValue(`--${token}`).trim();
      return value === "" ? [] : [[slot, srgbHex(value)]];
    }),
  );
}

export function terminalFont(root: Element = document.documentElement): string {
  return (
    getComputedStyle(root).getPropertyValue("--font-mono").trim() || "monospace"
  );
}
