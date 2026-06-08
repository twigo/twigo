import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import { cn } from "../lib/cn";

// Themed off our design tokens (var(--…)), so it adapts to light/dark with the
// rest of the app — no separate CodeMirror light/dark themes to maintain.
const editorTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    height: "100%",
    fontSize: "12px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    lineHeight: "1.6",
    overflow: "auto",
  },
  ".cm-gutters": {
    backgroundColor: "var(--background)",
    color: "var(--muted-foreground)",
    border: "none",
  },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--accent)",
  },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in oklab, var(--brand) 30%, transparent)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in oklab, var(--brand) 55%, transparent)",
  },
  ".cm-panels": {
    backgroundColor: "var(--panel)",
    color: "var(--foreground)",
    borderColor: "var(--border)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--muted)",
    color: "var(--muted-foreground)",
    border: "none",
    padding: "0 4px",
  },
});

const highlightStyle = HighlightStyle.define([
  { tag: t.propertyName, color: "var(--brand)" },
  { tag: [t.string, t.special(t.string)], color: "var(--ok)" },
  { tag: [t.number, t.bool, t.null, t.keyword], color: "var(--warn)" },
  {
    tag: [t.punctuation, t.separator, t.brace, t.squareBracket],
    color: "var(--muted-foreground)",
  },
]);

const commonExtensions: Extension[] = [
  syntaxHighlighting(highlightStyle),
  EditorView.lineWrapping,
];

const LANGUAGE: Record<"json" | "text", Extension[]> = {
  json: [json()],
  text: [],
};

const basicSetup = {
  lineNumbers: true,
  foldGutter: true,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  autocompletion: false,
  closeBrackets: false,
  // We provide our own highlight style above.
  syntaxHighlighting: false,
};

// Read-only code view with syntax highlighting, folding and search (Cmd/Ctrl+F).
export function CodeViewer({
  value,
  language = "text",
  className,
}: {
  value: string;
  language?: "json" | "text";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border border-border",
        className,
      )}
    >
      <CodeMirror
        value={value}
        readOnly
        height="100%"
        style={{ height: "100%" }}
        theme={editorTheme}
        extensions={[...LANGUAGE[language], ...commonExtensions]}
        basicSetup={basicSetup}
      />
    </div>
  );
}
