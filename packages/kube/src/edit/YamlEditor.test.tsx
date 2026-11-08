import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
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
}

const fake = vi.hoisted(() => ({
  models: [] as FakeModel[],
  views: [] as FakeView[],
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
      create: (_host: HTMLElement, { model }: { model: FakeModel }) => {
        const view = {
          model,
          cursor: 0,
          disposed: false,
          focused: false,
          focus() {
            this.focused = true;
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

test("a focus asked of the editor goes to its view now, or to the one it gets", async () => {
  const copies = await buffers();
  copies.focus(URI);
  const first = render(<YamlEditor uri={URI} text="a: 1" buffers={copies} />);
  expect(fake.views[0]?.focused).toBe(true);
  first.unmount();

  render(<YamlEditor uri={URI} text="a: 1" buffers={copies} />);
  expect(fake.views[1]?.focused).toBe(false);
  copies.focus(URI);
  expect(fake.views[1]?.focused).toBe(true);
  expect(copies.takeFocus(URI)).toBe(false);
});
