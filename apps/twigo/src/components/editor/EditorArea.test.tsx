import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import type { DockviewApi } from "dockview-react";

type SerializedLayout = ReturnType<DockviewApi["toJSON"]>;

// The mocked DockviewReact captures onReady so a test can drive it with a fake
// DockviewApi instead of a real (DOM-bound) Dockview instance.
const dv = vi.hoisted(() => ({
  onReady: null as null | ((e: { api: unknown }) => void),
}));
vi.mock("dockview-react", () => ({
  DockviewReact: (props: { onReady: (e: { api: unknown }) => void }) => {
    dv.onReady = props.onReady;
    return null;
  },
  themeDark: { className: "dark" },
  themeLight: { className: "light" },
}));

// Stub the domain opens/teardown (also keeps the heavy editor module out).
const ed = vi.hoisted(() => ({
  openStream: vi.fn(),
  closeEditorsForConn: vi.fn(),
}));
vi.mock("@/lib/editor", () => ed);

vi.mock("./registry", () => ({
  editorComponents: {},
  editorTabComponents: {},
  EDITORS: { stream: { connScoped: true, dispose: vi.fn() } },
}));

import { EditorArea } from "./EditorArea";
import { setEditorApi } from "@/shell/editorHost";
import { useConnections } from "@/store/connections";
import { useWorkspace } from "@/store/workspace";
import { useStream } from "@/store/stream";

const layout = (id: string) => ({ id }) as unknown as SerializedLayout;

function makeApi() {
  const cbs = { layout: [] as (() => void)[] };
  return {
    activePanel: undefined as unknown,
    panels: [] as unknown[],
    getPanel: vi.fn(() => undefined),
    toJSON: vi.fn(() => ({ saved: true })),
    fromJSON: vi.fn(),
    clear: vi.fn(),
    onDidActivePanelChange: vi.fn(() => ({ dispose: vi.fn() })),
    onDidRemovePanel: vi.fn(() => ({ dispose: vi.fn() })),
    onDidLayoutChange: vi.fn((cb: () => void) => {
      cbs.layout.push(cb);
      return { dispose: vi.fn() };
    }),
    _fireLayout: () => cbs.layout.forEach((c) => c()),
  };
}

function mountReady(api: ReturnType<typeof makeApi>) {
  render(<EditorArea />);
  act(() => {
    dv.onReady?.({ api });
  });
}

beforeEach(() => {
  dv.onReady = null;
  ed.openStream.mockClear();
  ed.closeEditorsForConn.mockClear();
  setEditorApi(null);
  useWorkspace.setState({ layouts: {}, activeContext: null });
  useStream.setState({ sessions: {}, activeId: null });
  useConnections.setState({ activeContext: "A", connected: {} });
});

afterEach(() => cleanup());

describe("EditorArea layout lifecycle", () => {
  it("restores the active connection's saved layout on ready", () => {
    useWorkspace.setState({ layouts: { A: layout("A") } });
    const api = makeApi();
    mountReady(api);
    expect(api.fromJSON).toHaveBeenCalledWith(layout("A"));
    expect(api.clear).not.toHaveBeenCalled();
  });

  it("falls back to clear() when the saved layout is corrupt, without throwing", () => {
    useWorkspace.setState({ layouts: { A: layout("bad") } });
    const api = makeApi();
    api.fromJSON.mockImplementation(() => {
      throw new Error("corrupt blob");
    });
    expect(() => mountReady(api)).not.toThrow();
    expect(api.fromJSON).toHaveBeenCalled();
    expect(api.clear).toHaveBeenCalled();
  });

  it("does not restore when there is no saved layout", () => {
    const api = makeApi();
    mountReady(api);
    expect(api.fromJSON).not.toHaveBeenCalled();
  });

  it("persists the layout (debounced) after a layout change", () => {
    vi.useFakeTimers();
    try {
      const api = makeApi();
      mountReady(api);
      act(() => api._fireLayout());
      // Not written yet - the save is debounced.
      expect(useWorkspace.getState().layouts.A).toBeUndefined();
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(useWorkspace.getState().layouts.A).toEqual({ saved: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes a pending layout save on beforeunload", () => {
    const api = makeApi();
    mountReady(api);
    act(() => api._fireLayout()); // arm the debounce
    expect(useWorkspace.getState().layouts.A).toBeUndefined();
    act(() => {
      window.dispatchEvent(new Event("beforeunload"));
    });
    expect(useWorkspace.getState().layouts.A).toEqual({ saved: true });
  });

  it("persists the outgoing layout and loads the incoming on connection switch", () => {
    useWorkspace.setState({ layouts: { A: layout("A"), B: layout("B") } });
    const api = makeApi();
    mountReady(api);
    expect(api.fromJSON).toHaveBeenLastCalledWith(layout("A"));

    act(() => useConnections.setState({ activeContext: "B" }));

    // Outgoing A snapshotted, incoming B loaded.
    expect(useWorkspace.getState().layouts.A).toEqual({ saved: true });
    expect(api.fromJSON).toHaveBeenLastCalledWith(layout("B"));
  });
});
