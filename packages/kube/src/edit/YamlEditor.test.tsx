import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { EditorShownContext } from "@twigo/workbench";
import { testWorkbench } from "@twigo/workbench/testing";
import { createEdits } from "./services";
import YamlEditor from "./YamlEditor";

interface FakeModel {
  value: string;
  disposed: boolean;
  readonly uri: string;
}

interface FakeView {
  readonly model: FakeModel;
  cursor: number;
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
    editor: {
      setModelMarkers: () => undefined,
      createModel: (value: string, _language: string, uri: string) => {
        const model = {
          value,
          disposed: false,
          uri,
          getValue() {
            return this.value;
          },
          setValue(next: string) {
            this.value = next;
            for (const view of fake.views) {
              if (view.model === this) view.cursor = 0;
            }
          },
          getVersionId: () => 1,
          onDidChangeContent: dispose,
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
          updateOptions: () => undefined,
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
