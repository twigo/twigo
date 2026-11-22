import { useEffect, useRef } from "react";
import { useEditorShown } from "@twigo/workbench";
import { editor, languages, textOptions, Uri } from "../edit/monaco";
import { documentsOf } from "./documents";
import { MASK, type Glyph } from "./reveals";

/** The scheme of the models of a release's texts, whose documents `@` lists. */
const MODELS = "twigo-helm";

languages.registerDocumentSymbolProvider(
  { language: "yaml", scheme: MODELS },
  {
    provideDocumentSymbols: (model) =>
      documentsOf(model.getValue()).map(({ name, from, to }) => ({
        name,
        detail: "",
        kind: languages.SymbolKind.File,
        tags: [],
        range: {
          startLineNumber: from,
          startColumn: 1,
          endLineNumber: to,
          endColumn: 1,
        },
        selectionRange: {
          startLineNumber: from,
          startColumn: 1,
          endLineNumber: from,
          endColumn: 1,
        },
      })),
  },
);

/**
 * A release's text, read-only YAML, with its masked values in the quiet role
 * and an eye in the gutter of each line that holds one, which reveals it, and
 * on the line of each that was revealed, which hides it. Only a text on
 * screen has a Monaco view, as a diff does (ARCHITECTURE 4.3).
 */
export default function MaskedText({
  id,
  text,
  glyphs,
  onGlyph,
}: {
  /** Names the model: one text, one model. */
  readonly id: string;
  readonly text: string;
  readonly glyphs: readonly Glyph[];
  readonly onGlyph: (glyph: Glyph) => void;
}) {
  const shown = useEditorShown();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<editor.IStandaloneCodeEditor>(undefined);
  const marks = useRef<editor.IEditorDecorationsCollection>(undefined);
  const latest = useRef({ text, glyphs, onGlyph });
  useEffect(() => {
    latest.current = { text, glyphs, onGlyph };
  });
  const place = useRef<editor.ICodeEditorViewState | null>(null);
  useEffect(() => {
    const element = host.current;
    if (!element || !shown) return;
    const model = editor.createModel(
      latest.current.text,
      "yaml",
      Uri.from({ scheme: MODELS, path: `/${id}` }),
    );
    const instance = editor.create(element, {
      model,
      readOnly: true,
      automaticLayout: true,
      glyphMargin: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      ...textOptions(),
      lineNumbersMinChars: 3,
      renderLineHighlight: "none",
    });
    if (place.current) instance.restoreViewState(place.current);
    view.current = instance;
    marks.current = instance.createDecorationsCollection([]);
    const click = instance.onMouseDown(({ target }) => {
      if (target.type !== editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = target.position.lineNumber;
      const found = latest.current.glyphs.find((each) => each.line === line);
      if (found) latest.current.onGlyph(found);
    });
    return () => {
      click.dispose();
      place.current = instance.saveViewState();
      instance.dispose();
      model.dispose();
      view.current = undefined;
      marks.current = undefined;
    };
  }, [shown, id]);
  useEffect(() => {
    const instance = view.current;
    const model = instance?.getModel();
    if (!instance || !model) return;
    if (model.getValue() !== text) {
      // `setValue` puts the cursor back at the start.
      const where = instance.saveViewState();
      model.setValue(text);
      if (where) instance.restoreViewState(where);
    }
    const masked = model.getLinesContent().flatMap((content, index) =>
      [...content.matchAll(new RegExp(MASK, "g"))].map(
        ({ index: from = 0, 0: found }) => ({
          range: {
            startLineNumber: index + 1,
            startColumn: from + 1,
            endLineNumber: index + 1,
            endColumn: from + 1 + found.length,
          },
          options: { inlineClassName: "twigo-masked" },
        }),
      ),
    );
    marks.current?.set([
      ...masked,
      ...glyphs.map((glyph) => ({
        range: {
          startLineNumber: glyph.line,
          startColumn: 1,
          endLineNumber: glyph.line,
          endColumn: 1,
        },
        options: {
          glyphMarginClassName: glyph.revealed ? "twigo-eye-off" : "twigo-eye",
          glyphMarginHoverMessage: { value: glyph.label },
        },
      })),
    ]);
  }, [text, glyphs, shown]);
  return <div ref={host} className="h-full w-full" />;
}
