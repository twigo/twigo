import { useEffect, useMemo, useRef } from "react";
import { useEditorShown } from "@twigo/workbench";
import { useWorkbench } from "@twigo/workbench";
import { topKeyMarks } from "../edit/landmarks";
import { editor, textOptions, Uri } from "../edit/monaco";
import { documentsOf, topKeysOf } from "./documents";
import type { Glyph } from "./reveals";

/** The scheme of the models of a release's texts. */
const MODELS = "twigo-helm";

/**
 * A release's text, read-only YAML as a Secret's is, with an eye in the gutter
 * of each line that holds a masked value, which reveals it, and on the first
 * line of each that was revealed, which hides it, the revealed lines on a
 * muted fill. Only a text on screen has a Monaco view, as a diff does
 * (ARCHITECTURE 4.3).
 */
export default function MaskedText({
  id,
  text,
  glyphs,
  onGlyph,
  symbols,
  onCursor,
}: {
  /** Names the model: one text, one model. */
  readonly id: string;
  readonly text: string;
  readonly glyphs: readonly Glyph[];
  readonly onGlyph: (glyph: Glyph) => void;
  /** The editor whose `@` lists the documents of the text, as a manifest's does. */
  readonly symbols?: string | undefined;
  readonly onCursor?: ((line: number) => void) | undefined;
}) {
  const { editors } = useWorkbench();
  const shown = useEditorShown();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<editor.IStandaloneCodeEditor>(undefined);
  const marks = useRef<editor.IEditorDecorationsCollection>(undefined);
  const latest = useRef({ text, glyphs, onGlyph, onCursor });
  useEffect(() => {
    latest.current = { text, glyphs, onGlyph, onCursor };
  });
  const keys = useMemo(() => topKeysOf(text), [text]);
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
    const moved = instance.onDidChangeCursorPosition(({ position }) => {
      latest.current.onCursor?.(position.lineNumber);
    });
    const act = (revealed: boolean) => (ed: editor.ICodeEditor) => {
      const line = ed.getPosition()?.lineNumber;
      const found = latest.current.glyphs.find(
        (each) => each.line === line && each.revealed === revealed,
      );
      if (found) latest.current.onGlyph(found);
    };
    const actions = [
      instance.addAction({
        id: "twigo.helm.reveal",
        label: "Reveal Value",
        contextMenuGroupId: "navigation",
        run: act(false),
      }),
      instance.addAction({
        id: "twigo.helm.hide",
        label: "Hide Value",
        contextMenuGroupId: "navigation",
        run: act(true),
      }),
    ];
    return () => {
      for (const action of actions) action.dispose();
      moved.dispose();
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
    marks.current?.set([
      ...topKeyMarks(keys, model),
      ...glyphs
        .filter(({ revealed }) => revealed)
        .map((glyph) => ({
          range: {
            startLineNumber: glyph.line,
            startColumn: 1,
            endLineNumber: glyph.to,
            endColumn: 1,
          },
          options: { isWholeLine: true, className: "twigo-revealed" },
        })),
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
  }, [text, glyphs, keys, shown]);
  useEffect(() => {
    const instance = view.current;
    if (!symbols || !shown || !instance) return;
    return editors.publishSymbols(
      symbols,
      documentsOf(text).map(({ name, from }) => ({
        label: name,
        detail: `line ${String(from)}`,
        reveal: () => {
          instance.revealLineNearTop(from);
          instance.setPosition({ lineNumber: from, column: 1 });
          instance.focus();
        },
      })),
    );
  }, [editors, symbols, shown, text]);
  return <div ref={host} className="h-full w-full" />;
}
