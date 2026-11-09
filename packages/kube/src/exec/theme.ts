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
 * xterm reads any CSS colour through a canvas, so the tokens' `oklch`
 * values pass as they are.
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
      return value === "" ? [] : [[slot, value]];
    }),
  );
}

export function terminalFont(root: Element = document.documentElement): string {
  return (
    getComputedStyle(root).getPropertyValue("--font-mono").trim() || "monospace"
  );
}
