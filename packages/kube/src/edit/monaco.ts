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
import "monaco-editor/features/find/register";
import "monaco-editor/features/folding/register";
import "monaco-editor/features/gotoError/register";
import "monaco-editor/features/hover/register";
import "monaco-editor/features/linesOperations/register";
import "monaco-editor/features/multicursor/register";
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

export { editor, KeyCode, MarkerSeverity, Uri };

function theme(): string {
  return document.documentElement.classList.contains("dark") ? "vs-dark" : "vs";
}

/** Keeps every Monaco editor on the app's light or dark theme, for as long as the app lives. */
const watch = new MutationObserver(() => {
  editor.setTheme(theme());
});
watch.observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["class"],
});
editor.setTheme(theme());
