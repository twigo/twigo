import { srgbHex } from "@twigo/ui";
import { editor } from "monaco-editor/editor";

/**
 * Monaco's theme from the tokens (ARCHITECTURE 4.9). Monaco takes `#rrggbb`
 * or `#rrggbbaa` and the tokens are `oklch`, many with alpha or `color-mix`,
 * so each one's computed value goes to the browser's own colour parser, a
 * canvas's `fillStyle`, and comes back in sRGB (`srgbHex`). A token colour of
 * a rule keeps only its `#rrggbb`: Monaco drops the alpha of a rule's colour.
 * Syntax colour lives here and nowhere else: keys in the brand, numbers and
 * keywords in cyan, comments in support, everything else, brackets included, in
 * content.
 */
function themeData(
  dark: boolean,
  hex: (token: string) => string,
): editor.IStandaloneThemeData {
  return {
    base: dark ? "vs-dark" : "vs",
    inherit: false,
    rules: [
      { token: "comment", foreground: hex("support") },
      { token: "type", foreground: hex("brand") },
      { token: "number", foreground: hex("ansi-cyan") },
      { token: "keyword", foreground: hex("ansi-cyan") },
      { token: "string.invalid", foreground: hex("error") },
    ],
    colors: {
      "editor.background": hex("editor"),
      "editor.foreground": hex("content"),
      "editorGutter.background": hex("editor"),
      "editorLineNumber.foreground": hex("quiet"),
      "editorLineNumber.activeForeground": hex("support"),
      "editor.selectionBackground": hex("selected"),
      "editor.inactiveSelectionBackground": hex("selected-unfocused"),
      "editor.selectionHighlightBackground": hex("row-active"),
      "editor.lineHighlightBackground": hex("row-hover"),
      "editorIndentGuide.background1": hex("border-subtle"),
      "editorIndentGuide.activeBackground1": hex("border"),
      "editorCursor.foreground": hex("content"),
      ...Object.fromEntries(
        [1, 2, 3, 4, 5, 6].map((level) => [
          `editorBracketHighlight.foreground${String(level)}`,
          hex("content"),
        ]),
      ),
      "editor.findMatchBackground": hex("mark-current"),
      // Monaco 0.57 swaps the two foregrounds: this one colours the current match.
      "editor.findMatchHighlightForeground": hex("mark-current-foreground"),
      "editor.findMatchForeground": hex("content"),
      "editor.findMatchHighlightBackground": hex("mark"),
      "editor.rangeHighlightBackground": hex("row-hover"),
      "editorError.foreground": hex("error"),
      "editorWarning.foreground": hex("warn"),
      "editorWidget.background": hex("popover"),
      "editorWidget.foreground": hex("content"),
      "editorWidget.border": hex("border"),
    },
  };
}

function apply(): void {
  const root = document.documentElement;
  const dark = root.classList.contains("dark");
  const style = getComputedStyle(root);
  const name = dark ? "twigo-dark" : "twigo-light";
  editor.defineTheme(
    name,
    themeData(dark, (token) =>
      srgbHex(style.getPropertyValue(`--${token}`).trim()),
    ),
  );
  editor.setTheme(name);
}

/** Keeps every Monaco editor on the app's light or dark theme, for as long as the app lives. */
export function followTheme(): void {
  new MutationObserver(apply).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  apply();
}
