import { editor, languages, Uri } from "monaco-editor/editor";
import "monaco-editor/languages/definitions/yaml/register";
import "monaco-editor/features/clipboard/register";
import "monaco-editor/features/codeAction/register";
import "monaco-editor/features/contextmenu/register";
import "monaco-editor/features/diffEditor/register";
import "monaco-editor/features/find/register";
import "monaco-editor/features/folding/register";
import "monaco-editor/features/gotoError/register";
import "monaco-editor/features/hover/register";
import "monaco-editor/features/readOnlyMessage/register";
import "monaco-editor/features/suggest/register";
import { configureMonacoYaml, type SchemasSettings } from "monaco-yaml";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import YamlWorker from "monaco-yaml/yaml.worker?worker";
import "./monaco.css";

self.MonacoEnvironment = {
  getWorker: (_id, label) =>
    label === "yaml" ? new YamlWorker() : new EditorWorker(),
};

/**
 * Monaco as the app bundles it (ARCHITECTURE 4.6): the tree-shakeable entry
 * points, and monaco-yaml configured once with the dialect kubectl reads. The
 * schemas it validates by are those of the models that have one.
 */
const yaml = configureMonacoYaml(
  { editor, languages, Uri },
  {
    yamlVersion: "1.1",
    format: { enable: false },
    schemas: [],
  },
);

const schemas = new Map<string, SchemasSettings>();

/** Validates and completes the model at `model` by `schema`; none removes its schema. */
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

export { editor, Uri };

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
