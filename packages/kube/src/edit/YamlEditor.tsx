import { useEffect, useRef } from "react";
import { editor } from "./monaco";

/**
 * A read-only YAML editor, bundled locally and loaded on its first use
 * (ARCHITECTURE 4.6); it follows the app's light or dark theme.
 */
export default function YamlEditor({ text }: { text: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<editor.IStandaloneCodeEditor>(undefined);
  useEffect(() => {
    if (!host.current) return;
    const created = editor.create(host.current, {
      value: "",
      language: "yaml",
      readOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 12,
      lineNumbersMinChars: 3,
      renderLineHighlight: "none",
    });
    view.current = created;
    return () => {
      created.dispose();
      view.current = undefined;
    };
  }, []);
  useEffect(() => {
    const model = view.current?.getModel();
    if (model && model.getValue() !== text) model.setValue(text);
  }, [text]);
  return <div ref={host} className="h-full w-full" />;
}
