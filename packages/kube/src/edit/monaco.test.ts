import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { textOptions } from "./monaco";

const fake = vi.hoisted(() => ({ remeasured: 0 }));

vi.mock("monaco-editor/editor", () => ({
  editor: {
    remeasureFonts: () => {
      fake.remeasured++;
    },
  },
  KeyCode: {},
  languages: {},
  MarkerSeverity: {},
  Uri: {},
}));
vi.mock("monaco-editor/languages/definitions/yaml/register", () => ({}));
vi.mock("monaco-editor/features/clipboard/register", () => ({}));
vi.mock("monaco-editor/features/codeAction/register", () => ({}));
vi.mock("monaco-editor/features/comment/register", () => ({}));
vi.mock("monaco-editor/features/contextmenu/register", () => ({}));
vi.mock("monaco-editor/features/diffEditor/register", () => ({}));
vi.mock("monaco-editor/features/find/register", () => ({}));
vi.mock("monaco-editor/features/folding/register", () => ({}));
vi.mock("monaco-editor/features/gotoError/register", () => ({}));
vi.mock("monaco-editor/features/hover/register", () => ({}));
vi.mock("monaco-editor/features/linesOperations/register", () => ({}));
vi.mock("monaco-editor/features/multicursor/register", () => ({}));
vi.mock("monaco-editor/features/readOnlyMessage/register", () => ({}));
vi.mock("monaco-editor/features/suggest/register", () => ({}));
vi.mock(
  "monaco-editor/editor/contrib/suggest/browser/suggestController",
  () => ({}),
);
vi.mock("monaco-editor/features/wordOperations/register", () => ({}));
vi.mock("monaco-editor/editor/editor.worker?worker", () => ({
  default: vi.fn(),
}));
vi.mock("monaco-yaml/yaml.worker?worker", () => ({ default: vi.fn() }));
vi.mock("monaco-yaml", () => ({ configureMonacoYaml: () => ({}) }));
vi.mock("./theme", () => ({ followTheme: () => undefined }));
vi.mock("./monaco.css", () => ({}));

const FAMILY = '"JetBrains Mono", monospace';
const REGULAR = `13px ${FAMILY}`;
const BOLD = `bold 13px ${FAMILY}`;

const loaded = new Set<string>();
const loading = new Map<string, (loaded: boolean) => void>();

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  document.documentElement.style.setProperty("--font-mono", FAMILY);
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      check: (face: string) => loaded.has(face),
      load: (face: string) =>
        new Promise((resolve, reject) => {
          loading.set(face, (ok) => {
            if (ok) resolve([]);
            else reject(new Error("the face did not load"));
          });
        }),
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(document, "fonts");
  document.documentElement.style.removeProperty("--font-mono");
  loaded.clear();
  loading.clear();
  fake.remeasured = 0;
});

test("the text is the app's monospace at 13 / 20 without ligatures, and an editor made with both faces loaded measures nothing again", async () => {
  loaded.add(REGULAR).add(BOLD);

  expect(textOptions()).toEqual({
    fontFamily: FAMILY,
    fontSize: 13,
    lineHeight: 20,
    fontLigatures: false,
  });

  await settled();
  expect([...loading.keys()]).toEqual([]);
  expect(fake.remeasured).toBe(0);
});

test("Monaco measures again once the regular and the bold face have loaded", async () => {
  textOptions();
  expect([...loading.keys()]).toEqual([REGULAR, BOLD]);

  loading.get(REGULAR)?.(true);
  await settled();
  expect(fake.remeasured).toBe(0);

  loading.get(BOLD)?.(true);
  await vi.waitFor(() => {
    expect(fake.remeasured).toBe(1);
  });
});

test("Monaco measures again when a face fails to load, once the other has settled", async () => {
  textOptions();

  loading.get(REGULAR)?.(false);
  await settled();
  expect(fake.remeasured).toBe(0);

  loading.get(BOLD)?.(true);
  await vi.waitFor(() => {
    expect(fake.remeasured).toBe(1);
  });
});
