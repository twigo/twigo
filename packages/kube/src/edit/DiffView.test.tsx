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
}));

vi.mock("./monaco", () => ({
  editor: {
    createModel: (value: string) => ({
      getValue: () => value,
      setValue: () => undefined,
      dispose: () => undefined,
    }),
    createDiffEditor: (
      _host: unknown,
      options: { hideUnchangedRegions?: { enabled?: boolean } },
    ) => {
      fake.options.push(options);
      const view = {
        disposed: false,
        restored: undefined as unknown,
        setModel: () => undefined,
        saveViewState: () => "where it was",
        restoreViewState(state: unknown) {
          this.restored = state;
        },
        getOriginalEditor: () => ({}),
        getModifiedEditor: () => ({}),
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
