import {
  editor,
  KeyCode,
  languages,
  MarkerSeverity,
  Uri,
} from "monaco-editor/editor";
import "monaco-editor/languages/definitions/yaml/register";
import "monaco-editor/features/clipboard/register";
import "monaco-editor/features/codeAction/register";
import "monaco-editor/features/comment/register";
import "monaco-editor/features/contextmenu/register";
import "monaco-editor/features/diffEditor/register";
import "monaco-editor/features/documentSymbols/register";
import "monaco-editor/features/find/register";
import "monaco-editor/features/folding/register";
import "monaco-editor/features/gotoError/register";
import "monaco-editor/features/hover/register";
import "monaco-editor/features/linesOperations/register";
import "monaco-editor/features/multicursor/register";
import "monaco-editor/features/quickOutline/register";
import "monaco-editor/features/readOnlyMessage/register";
import "monaco-editor/features/suggest/register";
// @todo: drop this import once `features/suggest/register` imports it: 0.57's
// registers only the inline completions, so `editor.action.triggerSuggest`
// and the suggest widget do not exist without the controller.
import "monaco-editor/editor/contrib/suggest/browser/suggestController";
import "monaco-editor/features/wordOperations/register";
import { configureMonacoYaml, type SchemasSettings } from "monaco-yaml";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import YamlWorker from "monaco-yaml/yaml.worker?worker";
import { followTheme } from "./theme";
import "./monaco.css";

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

/**
 * What monaco-worker-manager asks `editor.createWebWorker` for, on Monaco's
 * worker API of 0.56 and later: the options of the old one, `createData`
 * among them, become a worker that has been sent `createData` after the
 * message Monaco's own `internal/common/workers` sends first, which a worker
 * made with `initialize` reads as the one that starts it.
 */
function createWebWorker<T extends object>({
  createData,
}: {
  readonly createData: unknown;
}): editor.MonacoWebWorker<T> {
  const worker = new YamlWorker();
  worker.postMessage("ignore");
  worker.postMessage(createData);
  return editor.createWebWorker<T>({ worker });
}

/**
 * Monaco as the app bundles it (ARCHITECTURE 4.6): the tree-shakeable entry
 * points, and monaco-yaml configured once with the dialect kubectl reads. The
 * schemas it validates by are those of the models that have one.
 */
const yaml = configureMonacoYaml(
  // @todo: drop `createWebWorker` above and pass `editor` as it is once
  // monaco-worker-manager, which monaco-yaml asks for its worker, speaks
  // Monaco's worker API of 0.56 and later: its `createWebWorker({ moduleId,
  // label, createData })` is the API of 0.55 and before, and 2.0.1 is the
  // latest.
  { editor: { ...editor, createWebWorker }, languages, Uri },
  {
    yamlVersion: "1.1",
    format: { enable: false },
    schemas: [],
  },
);

const schemas = new Map<string, SchemasSettings>();

export function setSchema(
  model: Uri,
  source: string,
  schema: SchemasSettings["schema"] | undefined,
): Promise<undefined> {
  const key = model.toString();
  if (schema === undefined) schemas.delete(key);
  else schemas.set(key, { fileMatch: [key], uri: source, schema });
  return yaml.update({ schemas: [...schemas.values()] });
}

export { editor, KeyCode, languages, MarkerSeverity, Uri };

const FONT_SIZE = 13;

/**
 * What every editor draws its text with: the app's monospace at 13 / 20, no
 * ligatures. Monaco measures the face when an editor is created and keeps the
 * widths, so an editor made before the face has loaded would put its cursor
 * on the fallback's grid; `remeasureFonts` is Monaco's way to measure again,
 * and it comes once the regular and the bold face (which it measures too)
 * have loaded or failed.
 */
export function textOptions(): editor.IEditorOptions {
  const fontFamily = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-mono")
    .trim();
  const faces = [
    `${String(FONT_SIZE)}px ${fontFamily}`,
    `bold ${String(FONT_SIZE)}px ${fontFamily}`,
  ];
  if (!faces.every((face) => document.fonts.check(face))) {
    void Promise.allSettled(
      faces.map((face) => document.fonts.load(face)),
    ).then(() => {
      editor.remeasureFonts();
    });
  }
  return {
    fontFamily,
    fontSize: FONT_SIZE,
    lineHeight: 20,
    fontLigatures: false,
  };
}

followTheme();
