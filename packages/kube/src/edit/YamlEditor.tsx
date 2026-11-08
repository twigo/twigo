import { useEffect, useRef } from "react";
import { editor, MarkerSeverity, setSchema, Uri } from "./monaco";
import { statusLines } from "./object";

/** A place in the text that does not parse, 1-based. */
export interface TextError {
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

export interface YamlEditorProps {
  /** The editor's URI, which names its model: one editor, one model. */
  readonly uri: string;
  readonly text: string;
  readonly readOnly?: boolean;
  readonly onChange?: (text: string) => void;
  /** `status` is the server's where the resource has a `status` subresource. */
  readonly statusLocked?: boolean;
  readonly schema?: { readonly source: string; readonly schema: object };
  readonly error?: TextError;
}

const STATUS_IS_THE_SERVERS = {
  value: "`status` is the server's: Twigo does not send it.",
};

const MARKER_OWNER = "twigo";

/**
 * The YAML editor, bundled locally and loaded on its first use (ARCHITECTURE
 * 4.6), on the app's light or dark theme. Its text lives in the editor's
 * working copy, so this keeps nothing of its own: a model for as long as the
 * editor is shown.
 */
export default function YamlEditor({
  uri,
  text,
  readOnly = false,
  onChange,
  statusLocked = false,
  schema,
  error,
}: YamlEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const model = useRef<editor.ITextModel>(undefined);
  const view = useRef<editor.IStandaloneCodeEditor>(undefined);
  const changed = useRef(onChange);
  const latest = useRef(text);
  const setting = useRef(false);
  useEffect(() => {
    changed.current = onChange;
    latest.current = text;
  });

  useEffect(() => {
    if (!host.current) return;
    const modelUri = Uri.from({ scheme: "twigo-edit", path: `/${uri}` });
    editor.getModel(modelUri)?.dispose();
    const created = editor.createModel(latest.current, "yaml", modelUri);
    const instance = editor.create(host.current, {
      model: created,
      readOnly,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 12,
      lineNumbersMinChars: 3,
      renderLineHighlight: "none",
      tabSize: 2,
      insertSpaces: true,
      detectIndentation: false,
    });
    model.current = created;
    view.current = instance;
    const content = created.onDidChangeContent(() => {
      if (!setting.current) changed.current?.(created.getValue());
    });
    return () => {
      content.dispose();
      instance.dispose();
      created.dispose();
      model.current = undefined;
      view.current = undefined;
    };
  }, [uri, readOnly]);

  useEffect(() => {
    const current = model.current;
    if (!current || current.getValue() === text) return;
    setting.current = true;
    current.setValue(text);
    setting.current = false;
  }, [text]);

  useEffect(() => {
    const current = model.current;
    if (!current || !schema) return;
    void setSchema(current.uri, schema.source, schema.schema);
    return () => {
      void setSchema(current.uri, schema.source, undefined);
    };
  }, [uri, readOnly, schema]);

  useEffect(() => {
    const current = model.current;
    const instance = view.current;
    if (!current || !instance || readOnly || !statusLocked) return;
    let range = statusLines(current.getValue());
    let known = current.getVersionId();
    const lock = () => {
      if (current.getVersionId() !== known) {
        range = statusLines(current.getValue());
        known = current.getVersionId();
      }
      const lines = range;
      const touched =
        lines !== undefined &&
        (instance.getSelections() ?? []).some(
          (selection) =>
            selection.startLineNumber <= lines.to &&
            selection.endLineNumber >= lines.from,
        );
      instance.updateOptions({
        readOnly: touched,
        readOnlyMessage: STATUS_IS_THE_SERVERS,
      });
    };
    lock();
    const selection = instance.onDidChangeCursorSelection(lock);
    const content = current.onDidChangeContent(lock);
    return () => {
      selection.dispose();
      content.dispose();
      instance.updateOptions({ readOnly: false });
    };
  }, [uri, readOnly, statusLocked]);

  useEffect(() => {
    const current = model.current;
    if (!current) return;
    editor.setModelMarkers(
      current,
      MARKER_OWNER,
      error
        ? [
            {
              severity: MarkerSeverity.Error,
              message: error.message,
              startLineNumber: error.line,
              startColumn: error.column,
              endLineNumber: error.line,
              endColumn: error.column + 1,
            },
          ]
        : [],
    );
  }, [uri, readOnly, error]);

  return <div ref={host} className="h-full w-full" />;
}
