import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { EditorShownContext } from "@twigo/workbench";
import DiffView from "./DiffView";

interface FakeDiff {
  disposed: boolean;
  restored: unknown;
}

const fake = vi.hoisted(() => ({
  views: [] as FakeDiff[],
  options: [] as { hideUnchangedRegions?: { enabled?: boolean } }[],
  hosts: [] as HTMLElement[],
  content: 0,
  listeners: new Set<() => void>(),
}));

vi.mock("./monaco", () => ({
  editor: {
    createModel: (value: string) => ({
      getValue: () => value,
      setValue: () => undefined,
      dispose: () => undefined,
    }),
    createDiffEditor: (
      host: HTMLElement,
      options: { hideUnchangedRegions?: { enabled?: boolean } },
    ) => {
      fake.options.push(options);
      fake.hosts.push(host);
      const view = {
        disposed: false,
        restored: undefined as unknown,
        setModel: () => undefined,
        saveViewState: () => "where it was",
        restoreViewState(state: unknown) {
          this.restored = state;
        },
        getOriginalEditor: () => ({}),
        getModifiedEditor: () => ({
          getContentHeight: () => fake.content,
          onDidContentSizeChange: (listener: () => void) => {
            fake.listeners.add(listener);
            return { dispose: () => fake.listeners.delete(listener) };
          },
        }),
        dispose() {
          this.disposed = true;
        },
      };
      fake.views.push(view);
      return view;
    },
  },
}));

afterEach(() => {
  cleanup();
  fake.views.length = 0;
  fake.options.length = 0;
  fake.hosts.length = 0;
  fake.listeners.clear();
  fake.content = 0;
});

const shown = (on: boolean) => (
  <EditorShownContext.Provider value={on}>
    <DiffView original="a: 1" modified="a: 2" />
  </EditorShownContext.Provider>
);

test("a diff not on screen has no view, and shown again it is where it was", () => {
  const view = render(shown(true));
  view.rerender(shown(false));
  expect(fake.views.map(({ disposed }) => disposed)).toEqual([true]);

  view.rerender(shown(true));
  expect(fake.views).toHaveLength(2);
  expect(fake.views[1]?.restored).toBe("where it was");
});

test("a diff folds the lines that did not change only when asked to", () => {
  render(<DiffView original="a: 1" modified="a: 2" />);
  render(<DiffView collapseUnchanged original="a: 1" modified="a: 2" />);
  expect(fake.options.map((options) => options.hideUnchangedRegions)).toEqual([
    { enabled: false },
    { enabled: true },
  ]);
});

test("a diff given a height takes its content's, up to that, and follows the content", () => {
  fake.content = 120;
  const { container, rerender } = render(
    <DiffView maxHeight={300} original="a: 1" modified="a: 2" />,
  );
  const host = container.firstElementChild as HTMLElement;
  expect(host.style.height).toBe("120px");

  fake.content = 2160;
  for (const listener of fake.listeners) listener();
  expect(host.style.height).toBe("300px");

  fake.content = 54;
  for (const listener of fake.listeners) listener();
  expect(host.style.height).toBe("54px");

  rerender(<DiffView original="a: 1" modified="a: 2" />);
  expect(fake.listeners.size).toBe(0);
  expect(host.className).toContain("h-full");
});

test("a diff given no height fills its parent and listens to nothing", () => {
  fake.content = 120;
  const { container } = render(<DiffView original="a: 1" modified="a: 2" />);
  const host = container.firstElementChild as HTMLElement;
  expect(host.style.height).toBe("");
  expect(host.className).toContain("h-full");
  expect(fake.listeners.size).toBe(0);
});
