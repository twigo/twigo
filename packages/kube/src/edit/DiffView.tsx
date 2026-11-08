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
    models.current = pair;
    return () => {
      // A diff still being computed fails once its models are gone.
      view.setModel(null);
      view.dispose();
      pair.original.dispose();
      pair.modified.dispose();
      models.current = undefined;
    };
  }, []);
  useEffect(() => {
    const pair = models.current;
    if (!pair) return;
    if (pair.original.getValue() !== original) pair.original.setValue(original);
    if (pair.modified.getValue() !== modified) pair.modified.setValue(modified);
  }, [original, modified]);
  return <div ref={host} className="h-full w-full" />;
}
