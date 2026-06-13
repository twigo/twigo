import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import {
  autocompletion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import { cn } from "../lib/cn";

export type { CompletionSource };

const editorTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    height: "100%",
    fontSize: "12px",
    borderRadius: "var(--radius-md)",
  },
  "&.cm-focused": { outline: "none", boxShadow: "var(--focus-ring)" },
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
  "&.cm-focused .cm-selectionBackground, & .cm-selectionBackground, &.cm-focused .cm-content ::selection, & .cm-content ::selection":
    {
      backgroundColor:
        "color-mix(in oklab, var(--brand) 40%, transparent) !important",
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
  ".cm-tooltip": {
    backgroundColor: "var(--panel)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    color: "var(--foreground)",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: "12px",
    maxHeight: "16rem",
  },
  ".cm-tooltip-autocomplete ul li": { padding: "2px 8px" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "color-mix(in oklab, var(--brand) 30%, transparent)",
    color: "var(--foreground)",
  },
  ".cm-completionIcon": { display: "none" },
  ".cm-completionMatchedText": {
    color: "var(--brand)",
    textDecoration: "none",
    fontWeight: "600",
  },
  ".cm-completionDetail": {
    color: "var(--muted-foreground)",
    fontStyle: "normal",
    marginLeft: "0.75rem",
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
  syntaxHighlighting: false,
};

export function CodeViewer({
  value,
  language = "text",
  className,
  onChange,
  completion,
}: {
  value: string;
  language?: "json" | "text";
  className?: string;
  onChange?: (value: string) => void;
  completion?: CompletionSource;
}) {
  const editable = onChange !== undefined;
  const extensions = [...LANGUAGE[language], ...commonExtensions];
  if (completion)
    extensions.push(
      autocompletion({ override: [completion], activateOnTyping: true }),
    );
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border border-border",
        className,
      )}
    >
      <CodeMirror
        value={value}
        editable={editable}
        readOnly={!editable}
        height="100%"
        style={{ height: "100%" }}
        theme={editorTheme}
        extensions={extensions}
        basicSetup={basicSetup}
        onChange={onChange}
      />
    </div>
  );
}
