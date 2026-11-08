import { useEffect, useRef } from "react";
import { editor } from "./monaco";

export default function DiffView({
  original,
  modified,
}: {
  readonly original: string;
  readonly modified: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const diff = useRef<editor.IStandaloneDiffEditor>(undefined);
  const models = useRef<{
    original: editor.ITextModel;
    modified: editor.ITextModel;
  }>(undefined);
  const latest = useRef({ original, modified });
  useEffect(() => {
    latest.current = { original, modified };
  });
  useEffect(() => {
    if (!host.current) return;
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
    });
    view.setModel(pair);
    diff.current = view;
    models.current = pair;
    return () => {
      // A diff still being computed fails once its models are gone.
      view.setModel(null);
      view.dispose();
      pair.original.dispose();
      pair.modified.dispose();
      diff.current = undefined;
      models.current = undefined;
    };
  }, []);
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
