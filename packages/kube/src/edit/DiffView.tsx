import { useEffect, useRef } from "react";
import { useEditorShown } from "@twigo/workbench";
import { editor } from "./monaco";

export default function DiffView({
  original,
  modified,
  collapseUnchanged = false,
}: {
  readonly original: string;
  readonly modified: string;
  readonly collapseUnchanged?: boolean;
}) {
  const shown = useEditorShown();
  const host = useRef<HTMLDivElement>(null);
  const place = useRef<editor.IDiffEditorViewState | null>(null);
  const diff = useRef<editor.IStandaloneDiffEditor>(undefined);
  const models = useRef<{
    original: editor.ITextModel;
    modified: editor.ITextModel;
  }>(undefined);
  const latest = useRef({ original, modified });
  useEffect(() => {
    latest.current = { original, modified };
  });
  // Only a diff on screen has a Monaco view, as a YAML editor's does; the
  // diff's own place in it is kept for when it shows again.
  useEffect(() => {
    if (!host.current || !shown) return;
    const pair = {
      original: editor.createModel(latest.current.original, "yaml"),
      modified: editor.createModel(latest.current.modified, "yaml"),
    };
    const view = editor.createDiffEditor(host.current, {
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 12,
      lineNumbersMinChars: 3,
      renderOverviewRuler: false,
      hideUnchangedRegions: { enabled: collapseUnchanged },
    });
    view.setModel(pair);
    if (place.current) view.restoreViewState(place.current);
    diff.current = view;
    models.current = pair;
    return () => {
      place.current = view.saveViewState();
      // A diff still being computed fails once its models are gone.
      view.setModel(null);
      view.dispose();
      pair.original.dispose();
      pair.modified.dispose();
      diff.current = undefined;
      models.current = undefined;
    };
  }, [shown, collapseUnchanged]);
  useEffect(() => {
    const pair = models.current;
    const view = diff.current;
    if (!pair || !view) return;
    // `setValue` puts the cursor and the selection back at the start.
    const update = (
      model: editor.ITextModel,
      side: editor.ICodeEditor,
      text: string,
    ) => {
      if (model.getValue() === text) return;
      const where = side.saveViewState();
      model.setValue(text);
      if (where) side.restoreViewState(where);
    };
    update(pair.original, view.getOriginalEditor(), original);
    update(pair.modified, view.getModifiedEditor(), modified);
  }, [original, modified]);
  return <div ref={host} className="h-full w-full" />;
}
