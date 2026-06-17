import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DockviewApi } from "dockview-react";
import {
  setEditorApi,
  hasEditorApi,
  isReplacingLayout,
  withReplacingLayout,
  canSplitActiveEditor,
  editorGroupCount,
  splitActiveEditor,
  focusNextEditorGroup,
  resetEditorLayout,
} from "./editorHost";

type Mock = ReturnType<typeof vi.fn>;

interface FakePanel {
  id: string;
  group: FakeGroup;
  api: { setActive: Mock; moveTo: Mock; close: Mock };
}
interface FakeGroup {
  id: string;
  panels: FakePanel[];
}
interface FakeApi {
  groups: FakeGroup[];
  panels: FakePanel[];
  activePanel: FakePanel | undefined;
  activeGroup: FakeGroup | undefined;
  addGroup: Mock;
  moveToNext: Mock;
}

function panel(id: string, group: FakeGroup): FakePanel {
  const p: FakePanel = {
    id,
    group,
    api: { setActive: vi.fn(), moveTo: vi.fn(), close: vi.fn() },
  };
  group.panels.push(p);
  return p;
}

function setApi(api: FakeApi | null) {
  setEditorApi(api as unknown as DockviewApi | null);
}

beforeEach(() => setApi(null));

describe("withReplacingLayout", () => {
  it("raises the flag inside and lowers it after, returning the value", () => {
    expect(isReplacingLayout()).toBe(false);
    const result = withReplacingLayout(() => {
      expect(isReplacingLayout()).toBe(true);
      return 42;
    });
    expect(result).toBe(42);
    expect(isReplacingLayout()).toBe(false);
  });

  it("composes nested regions via the depth counter", () => {
    withReplacingLayout(() => {
      withReplacingLayout(() => undefined);
      // The inner exit must not clear the flag while the outer region is open.
      expect(isReplacingLayout()).toBe(true);
    });
    expect(isReplacingLayout()).toBe(false);
  });

  it("lowers the flag even when the body throws", () => {
    expect(() =>
      withReplacingLayout(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(isReplacingLayout()).toBe(false);
  });
});

describe("pane ops without an editor api", () => {
  it("are inert and never throw", () => {
    expect(hasEditorApi()).toBe(false);
    expect(canSplitActiveEditor()).toBe(false);
    expect(editorGroupCount()).toBe(0);
    splitActiveEditor("right");
    focusNextEditorGroup();
    resetEditorLayout();
  });
});

describe("pane ops with an editor api", () => {
  it("reports group count and whether the active tab can split", () => {
    const g: FakeGroup = { id: "g0", panels: [] };
    const only = panel("p0", g);
    setApi({
      groups: [g],
      panels: [only],
      activePanel: only,
      activeGroup: g,
      addGroup: vi.fn(),
      moveToNext: vi.fn(),
    });
    expect(hasEditorApi()).toBe(true);
    expect(editorGroupCount()).toBe(1);
    expect(canSplitActiveEditor()).toBe(false); // alone in its group

    panel("p1", g); // now the group hosts two tabs
    expect(canSplitActiveEditor()).toBe(true);
  });

  it("splits the active tab into a new group", () => {
    const g: FakeGroup = { id: "g0", panels: [] };
    const active = panel("p0", g);
    const newGroup: FakeGroup = { id: "g1", panels: [] };
    const api: FakeApi = {
      groups: [g],
      panels: [active],
      activePanel: active,
      activeGroup: g,
      addGroup: vi.fn(() => newGroup),
      moveToNext: vi.fn(),
    };
    setApi(api);
    splitActiveEditor("below");
    expect(api.addGroup).toHaveBeenCalledWith({
      referenceGroup: g,
      direction: "below",
    });
    expect(active.api.moveTo).toHaveBeenCalledWith({ group: newGroup });
  });

  it("cycles focus to the next group", () => {
    const g: FakeGroup = { id: "g0", panels: [] };
    const only = panel("p0", g);
    const api: FakeApi = {
      groups: [g],
      panels: [only],
      activePanel: only,
      activeGroup: g,
      addGroup: vi.fn(),
      moveToNext: vi.fn(),
    };
    setApi(api);
    focusNextEditorGroup();
    expect(api.moveToNext).toHaveBeenCalledWith({ includePanel: false });
  });

  it("collapses splits back into the first group", () => {
    const g0: FakeGroup = { id: "g0", panels: [] };
    const g1: FakeGroup = { id: "g1", panels: [] };
    const a = panel("a", g0);
    const b = panel("b", g1);
    setApi({
      groups: [g0, g1],
      panels: [a, b],
      activePanel: b,
      activeGroup: g1,
      addGroup: vi.fn(),
      moveToNext: vi.fn(),
    });
    resetEditorLayout();
    expect(b.api.moveTo).toHaveBeenCalledWith({ group: g0 });
    expect(a.api.moveTo).not.toHaveBeenCalled(); // already in the target group
    expect(a.api.setActive).toHaveBeenCalled(); // first tab of target focused
  });
});
