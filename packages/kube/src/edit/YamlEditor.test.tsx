import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { EditorShownContext } from "@twigo/workbench";
import { testWorkbench } from "@twigo/workbench/testing";
import { createEdits } from "./services";
import YamlEditor from "./YamlEditor";

interface FakeModel {
  value: string;
  disposed: boolean;
  readonly uri: string;
  edit(text: string): void;
}

interface Decoration {
  readonly range: {
    readonly startLineNumber: number;
    readonly startColumn: number;
    readonly endLineNumber: number;
    readonly endColumn: number;
  };
  readonly options: { readonly inlineClassName: string };
}

interface FakeView {
  readonly model: FakeModel;
  readonly decorations: Decoration[][];
  cursor: number;
  line: number;
  moved: (() => void) | undefined;
  disposed: boolean;
  focused: boolean;
  focus(): void;
}

const fake = vi.hoisted(() => ({
  models: [] as FakeModel[],
  views: [] as FakeView[],
  options: [] as object[],
  /** As Monaco's `type`: the text goes to the first view that says it has the focus. */
  type(text: string) {
    const view = this.views.find(
      ({ disposed, focused }) => focused && !disposed,
    );
    if (view) view.model.value += text;
  },
}));

vi.mock("./monaco", () => {
  const dispose = () => ({ dispose: () => undefined });
  return {
    MarkerSeverity: { Error: 8 },
    KeyCode: {},
    Uri: { from: ({ path }: { path: string }) => path },
    setSchema: () => Promise.resolve(undefined),
    textOptions: () => ({}),
    editor: {
      setModelMarkers: () => undefined,
      createModel: (value: string, _language: string, uri: string) => {
        const model = {
          value,
          disposed: false,
          uri,
          version: 1,
          listeners: new Set<() => void>(),
          getValue() {
            return this.value;
          },
          edit(next: string) {
            this.value = next;
            this.version++;
            for (const listener of [...this.listeners]) listener();
          },
          setValue(next: string) {
            this.edit(next);
            for (const view of fake.views) {
              if (view.model === this) view.cursor = 0;
            }
          },
          getVersionId() {
            return this.version;
          },
          getPositionAt(offset: number) {
            const before = this.value.slice(0, offset).split("\n");
            return {
              lineNumber: before.length,
              column: (before[before.length - 1]?.length ?? 0) + 1,
            };
          },
          getLineMaxColumn(line: number) {
            return (this.value.split("\n")[line - 1]?.length ?? 0) + 1;
          },
          onDidChangeContent(listener: () => void) {
            this.listeners.add(listener);
            return { dispose: () => this.listeners.delete(listener) };
          },
          dispose() {
            this.disposed = true;
          },
        };
        fake.models.push(model);
        return model;
      },
      create: (host: HTMLElement, options: { model: FakeModel }) => {
        const { model } = options;
        fake.options.push(options);
        const input = document.createElement("textarea");
        host.append(input);
        const view = {
          model,
          cursor: 0,
          line: 1,
          moved: undefined as (() => void) | undefined,
          disposed: false,
          focused: false,
          focus() {
            this.focused = true;
            input.focus();
          },
          saveViewState() {
            return { cursor: this.cursor };
          },
          restoreViewState(state: { cursor: number }) {
            this.cursor = state.cursor;
          },
          dispose() {
            this.disposed = true;
          },
          decorations: [] as Decoration[][],
          updateOptions: () => undefined,
          createDecorationsCollection(initial: Decoration[]) {
            this.decorations.push(initial);
            return {
              set: (next: Decoration[]) => this.decorations.push(next),
            };
          },
          getPosition() {
            return { lineNumber: this.line, column: 1 };
          },
          onDidChangeCursorPosition(listener: () => void) {
            this.moved = listener;
            return dispose();
          },
          onKeyDown: dispose,
          onDidCompositionStart: dispose,
          onDidCompositionEnd: dispose,
        };
        fake.views.push(view);
        return view;
      },
    },
  };
});

afterEach(() => {
  cleanup();
  fake.models.length = 0;
  fake.views.length = 0;
  fake.options.length = 0;
});

const URI = "k8s://dev//v1/configmaps/default/settings";

async function buffers() {
  const workbench = await testWorkbench("ready");
  return createEdits(workbench).copies;
}

test("the model and the view's state outlive the view that shows them, until the editor closes", async () => {
  const copies = await buffers();
  const first = render(<YamlEditor uri={URI} text="a: 1" buffers={copies} />);
  const [model] = fake.models;
  const [shown] = fake.views;
  if (!model || !shown) throw new Error("no editor was made");
  shown.cursor = 42;
  first.unmount();
  expect(shown.disposed).toBe(true);
  expect(model.disposed).toBe(false);

  render(<YamlEditor uri={URI} text="a: 1" buffers={copies} />);
  expect(fake.models).toHaveLength(1);
  expect(fake.views[1]?.model).toBe(model);
  expect(fake.views[1]?.cursor).toBe(42);

  copies.closed(URI);
  expect(model.disposed).toBe(true);
});

test("completion rises as a key is typed, which YAML tokenizes as a string, and offers no words of the document", () => {
  render(<YamlEditor uri="details:1" text="a: 1" readOnly />);
  expect(fake.options[0]).toMatchObject({
    quickSuggestions: { strings: true },
    wordBasedSuggestions: "off",
  });
});

test("a viewer without buffers keeps nothing of its own", () => {
  render(<YamlEditor uri="details:1" text="a: 1" readOnly />).unmount();
  expect(fake.models.map(({ disposed }) => disposed)).toEqual([true]);
});

test("a text that comes from outside replaces the model's and leaves the cursor where it was", async () => {
  const copies = await buffers();
  const view = render(<YamlEditor uri={URI} text="a: 1" buffers={copies} />);
  const [shown] = fake.views;
  if (!shown) throw new Error("no editor was made");
  shown.cursor = 7;
  view.rerender(<YamlEditor uri={URI} text="a: 2" buffers={copies} />);
  expect(fake.models[0]?.value).toBe("a: 2");
  expect(shown.cursor).toBe(7);
});

test("a focus asked of the editor goes to its view now, or to the one it gets, and a view replaced while it holds the focus hands it on", async () => {
  const copies = await buffers();
  copies.focus(URI);
  const first = render(<YamlEditor uri={URI} text="a: 1" buffers={copies} />);
  expect(fake.views[0]?.focused).toBe(true);
  first.rerender(
    <YamlEditor uri={URI} text="a: 1" buffers={copies} readOnly />,
  );
  expect(fake.views[0]?.disposed).toBe(true);
  expect(fake.views[1]?.focused).toBe(true);

  first.unmount();
  const third = render(<YamlEditor uri={URI} text="a: 1" buffers={copies} />);
  expect(fake.views[2]?.focused).toBe(false);
  copies.focus(URI);
  expect(fake.views[2]?.focused).toBe(true);
  expect(copies.takeFocus(URI)).toBe(false);

  third.unmount();
  render(<YamlEditor uri={URI} text="a: 1" buffers={copies} />);
  expect(fake.views[3]?.focused).toBe(false);
});

test("an editor that is not on screen has no view, so a key typed into the one that is cannot reach its text", async () => {
  const copies = await buffers();
  const OTHER = "k8s://dev//v1/configmaps/default/other";
  const shown = (uri: string, on: boolean) => (
    <EditorShownContext.Provider value={on}>
      <YamlEditor uri={uri} text="a: 1" buffers={copies} />
    </EditorShownContext.Provider>
  );
  const a = render(shown(URI, true));
  const [view] = fake.views;
  view?.focus();
  a.rerender(shown(URI, false));
  expect(view?.disposed).toBe(true);
  render(shown(OTHER, true));
  fake.views[1]?.focus();

  fake.type("typed");

  expect(fake.models.map(({ value }) => value)).toEqual(["a: 1", "a: 1typed"]);
  expect(fake.models.map(({ disposed }) => disposed)).toEqual([false, false]);

  a.rerender(shown(URI, true));
  expect(fake.views[2]?.model).toBe(fake.models[0]);
});

test("the path to the cursor's line shows above the editor and follows the cursor", () => {
  const { container } = render(
    <YamlEditor uri="details:1" text={"a:\n  b: 1\nc: 2\n"} readOnly />,
  );
  const view = fake.views[0];
  if (!view) throw new Error("no editor was made");
  const shown = () => container.querySelector("[title]")?.getAttribute("title");
  const moveTo = (line: number) => {
    act(() => {
      view.line = line;
      view.moved?.();
    });
  };

  expect(shown()).toBe("a");
  moveTo(2);
  expect(shown()).toBe("a › b");
  moveTo(3);
  expect(shown()).toBe("c");
  moveTo(9);
  expect(shown()).toBe("");
});

test("the decorations and the path follow an edit", () => {
  const before = "kind: Pod\nmetadata:\n  name: web\n";
  const after = `${before}  managedFields:\n    - manager: kubectl\nspec:\n  a: 1\n`;
  const { container } = render(<YamlEditor uri="details:2" text={before} />);
  const [model] = fake.models;
  const [view] = fake.views;
  if (!model || !view) throw new Error("no editor was made");
  const landmarks = () =>
    view.decorations[view.decorations.length - 1]?.map(
      ({ range: r, options }) => [
        options.inlineClassName,
        r.startLineNumber,
        r.startColumn,
        r.endLineNumber,
        r.endColumn,
      ],
    );
  const shown = () => container.querySelector("[title]")?.getAttribute("title");

  expect(landmarks()).toEqual([
    ["twigo-yaml-top-key", 1, 1, 1, 5],
    ["twigo-yaml-top-key", 2, 1, 2, 9],
  ]);
  act(() => {
    view.line = 7;
    view.moved?.();
  });
  expect(shown()).toBe("");

  act(() => {
    model.edit(after);
  });

  expect(landmarks()).toEqual([
    ["twigo-yaml-top-key", 1, 1, 1, 5],
    ["twigo-yaml-top-key", 2, 1, 2, 9],
    ["twigo-yaml-top-key", 6, 1, 6, 5],
    ["twigo-yaml-support", 4, 1, 5, 23],
  ]);
  expect(shown()).toBe("spec › a");
});
