import { useEffect, useRef } from "react";
import { editor } from "monaco-editor/editor";
import "monaco-editor/languages/definitions/yaml/register";
import "monaco-editor/features/clipboard/register";
import "monaco-editor/features/contextmenu/register";
import "monaco-editor/features/find/register";
import "monaco-editor/features/folding/register";
import "monaco-editor/features/readOnlyMessage/register";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import "./monaco.css";

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

function theme(): string {
  return document.documentElement.classList.contains("dark") ? "vs-dark" : "vs";
}

/**
 * A read-only YAML editor, bundled locally and loaded on its first use
 * (ARCHITECTURE 4.6); it follows the app's light or dark theme.
 */
export default function YamlView({ text }: { text: string }) {
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
      theme: theme(),
    });
    view.current = created;
    const watch = new MutationObserver(() => {
      editor.setTheme(theme());
    });
    watch.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => {
      watch.disconnect();
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
