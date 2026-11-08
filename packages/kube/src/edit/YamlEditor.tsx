import { useEffect, useRef } from "react";
import type { EditorBuffer } from "./copies";
import type { IKeyboardEvent, IPosition } from "monaco-editor/editor";
import { editor, KeyCode, MarkerSeverity, setSchema, Uri } from "./monaco";
import { statusLines } from "./object";
import {
  joinsStatus,
  touchesStatus,
  type Place,
  type StatusBlock,
} from "./statusLock";

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
  /**
   * Keeps the editor's model, cursor, scroll and undo while it is not shown.
   * Without it they go with the view, as in a read-only viewer.
   */
  readonly buffers?: {
    buffer(uri: string, make: () => EditorBuffer): EditorBuffer;
    takeFocus(uri: string): boolean;
  };
}

const STATUS_IS_THE_SERVERS = {
  value: "`status` is the server's: Twigo does not send it.",
};

const MARKER_OWNER = "twigo";

const MAC = navigator.userAgent.includes("Mac");

const placeOf = ({ lineNumber, column }: IPosition): Place => ({
  line: lineNumber,
  column,
});

/** Undo and redo, ⌘Z and ⌘Y or Ctrl's. */
function undoes(event: IKeyboardEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    (event.keyCode === KeyCode.KeyZ || event.keyCode === KeyCode.KeyY)
  );
}

/** The keys that delete at the cursor: Backspace and Delete with any word or line modifier, and macOS's Ctrl+H, Ctrl+D and Ctrl+K. */
function deletes(event: IKeyboardEvent): "backwards" | "forwards" | undefined {
  if (event.keyCode === KeyCode.Backspace) return "backwards";
  if (event.keyCode === KeyCode.Delete) return "forwards";
  if (!MAC || !event.ctrlKey || event.metaKey || event.altKey) return undefined;
  if (event.keyCode === KeyCode.KeyH) return "backwards";
  if (event.keyCode === KeyCode.KeyD || event.keyCode === KeyCode.KeyK)
    return "forwards";
  return undefined;
}

/**
 * The YAML editor, bundled locally and loaded on its first use (ARCHITECTURE
 * 4.6), on the app's light or dark theme. Its text lives in the editor's
 * working copy and its model in `buffers`, so this keeps nothing of its own.
 */
export default function YamlEditor({
  uri,
  text,
  readOnly = false,
  onChange,
  statusLocked = false,
  schema,
  error,
  buffers,
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
    const make = (): EditorBuffer => ({
      model: editor.createModel(
        latest.current,
        "yaml",
        Uri.from({ scheme: "twigo-edit", path: `/${uri}` }),
      ),
      view: null,
    });
    const buffer = buffers ? buffers.buffer(uri, make) : make();
    const created = buffer.model;
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
    if (buffer.view) instance.restoreViewState(buffer.view);
    model.current = created;
    view.current = instance;
    buffer.focus = () => {
      instance.focus();
    };
    if (buffers?.takeFocus(uri)) instance.focus();
    const content = created.onDidChangeContent(() => {
      if (!setting.current) changed.current?.(created.getValue());
    });
    return () => {
      buffer.view = instance.saveViewState();
      buffer.focus = undefined;
      content.dispose();
      instance.dispose();
      if (!buffers) created.dispose();
      model.current = undefined;
      view.current = undefined;
    };
  }, [uri, readOnly, buffers]);

  useEffect(() => {
    const current = model.current;
    if (!current || current.getValue() === text) return;
    // `setValue` puts the cursor back at the start.
    const where = view.current?.saveViewState();
    setting.current = true;
    current.setValue(text);
    setting.current = false;
    if (where) view.current?.restoreViewState(where);
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
    const block = (): StatusBlock | undefined => {
      if (current.getVersionId() !== known) {
        range = statusLines(current.getValue());
        known = current.getVersionId();
      }
      return (
        range && { ...range, endColumn: current.getLineMaxColumn(range.to) }
      );
    };
    const lock = () => {
      const found = block();
      const touched =
        found !== undefined &&
        (instance.getSelections() ?? []).some((selection) =>
          touchesStatus(found, {
            start: placeOf(selection.getStartPosition()),
            end: placeOf(selection.getEndPosition()),
          }),
        );
      instance.updateOptions({
        readOnly: touched,
        readOnlyMessage: STATUS_IS_THE_SERVERS,
      });
    };
    lock();
    // Monaco reads a key after this does, and a read-only editor refuses
    // undo and redo along with typing, so a key sets the lock for itself,
    // and the cursor's lock comes back once Monaco has acted.
    const keys = instance.onKeyDown((event) => {
      const found = block();
      const caret = instance.getPosition();
      if (undoes(event)) {
        instance.updateOptions({ readOnly: false });
      } else {
        const direction = deletes(event);
        if (
          !direction ||
          !found ||
          !caret ||
          !instance.getSelection()?.isEmpty() ||
          !joinsStatus(found, placeOf(caret), direction, (line) =>
            current.getLineMaxColumn(line),
          )
        )
          return;
        instance.updateOptions({
          readOnly: true,
          readOnlyMessage: STATUS_IS_THE_SERVERS,
        });
      }
      setTimeout(lock, 0);
    });
    const selection = instance.onDidChangeCursorSelection(lock);
    const content = current.onDidChangeContent(lock);
    return () => {
      keys.dispose();
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
