import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { DockviewApi } from "dockview-react";

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(() => Promise.resolve()),
  unsubscribe: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/api", () => ({
  Channel: class {
    onmessage: (m: unknown) => void = () => undefined;
  },
  subscribe: mocks.subscribe,
  unsubscribe: mocks.unsubscribe,
}));

import { setEditorApi, openSettings } from "@/shell/editorHost";
import {
  openStream,
  openServerInfo,
  openPublish,
  closeEditorsForConn,
} from "./editor";
import { useStream } from "@/store/stream";

interface PanelApi {
  setActive: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  updateParameters: ReturnType<typeof vi.fn>;
}
interface FakePanel {
  id: string;
  params: Record<string, unknown>;
  api: PanelApi;
  group: { id: string };
}
interface AddOpts {
  id: string;
  component: string;
  params?: Record<string, unknown>;
  position?: { referenceGroup: string; index: number };
}

function makeApi(activeGroup: { id: string } | undefined) {
  const map = new Map<string, FakePanel>();
  const addPanel = vi.fn((opts: AddOpts): FakePanel => {
    const panel: FakePanel = {
      id: opts.id,
      params: opts.params ?? {},
      group: { id: "g1" },
      api: {
        setActive: vi.fn(),
        close: vi.fn(() => map.delete(opts.id)),
        updateParameters: vi.fn((p: Record<string, unknown>) => {
          const pn = map.get(opts.id);
          if (pn) pn.params = p;
        }),
      },
    };
    map.set(opts.id, panel);
    return panel;
  });
  return {
    addPanel,
    getPanel: (id: string) => map.get(id),
    activeGroup,
    get panels(): FakePanel[] {
      return [...map.values()];
    },
  };
}

type Api = ReturnType<typeof makeApi>;

let api: Api;

beforeEach(() => {
  mocks.subscribe.mockClear();
  mocks.unsubscribe.mockClear();
  useStream.setState({ sessions: {}, activeId: null });
  api = makeApi({ id: "g1" });
  setEditorApi(api as unknown as DockviewApi);
});

afterEach(async () => {
  for (const id of Object.keys(useStream.getState().sessions)) {
    await useStream.getState().close(id);
  }
});

describe("editor service", () => {
  it("opens a server-info tab and dedups by id", () => {
    openServerInfo("local");
    expect(api.addPanel).toHaveBeenCalledTimes(1);
    expect(api.addPanel.mock.calls[0]?.[0]).toMatchObject({
      id: "server:local",
      component: "server",
    });

    const panel = api.getPanel("server:local");
    openServerInfo("local");
    expect(api.addPanel).toHaveBeenCalledTimes(1);
    expect(panel?.api.setActive).toHaveBeenCalled();
  });

  it("opens settings as the first tab", () => {
    openSettings();
    expect(api.addPanel.mock.calls[0]?.[0]).toMatchObject({
      id: "settings",
      component: "settings",
      position: { referenceGroup: "g1", index: 0 },
    });
  });

  it("opens settings without a position when there is no active group", () => {
    api = makeApi(undefined);
    setEditorApi(api as unknown as DockviewApi);
    openSettings();
    const call = api.addPanel.mock.calls[0]?.[0];
    expect(call).toMatchObject({ id: "settings", component: "settings" });
    expect(call?.position).toBeUndefined();
  });

  it("opens a stream tab and creates a session", async () => {
    await openStream("local", "orders.new");
    const id = "stream:local:orders.new";
    expect(useStream.getState().sessions[id]).toBeDefined();
    expect(api.getPanel(id)).toBeDefined();
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
  });

  it("reopening the same stream focuses the tab without re-subscribing", async () => {
    await openStream("local", "orders.new");
    await openStream("local", "orders.new");
    expect(api.addPanel).toHaveBeenCalledTimes(1);
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    expect(
      api.getPanel("stream:local:orders.new")?.api.setActive,
    ).toHaveBeenCalled();
  });

  it("encodes ':' in stream ids so they cannot collide", async () => {
    await openStream("local", "a:b");
    expect(api.getPanel("stream:local:a%3Ab")).toBeDefined();
  });

  it("closes stream and server tabs and unsubscribes for a connection", async () => {
    await openStream("local", "orders.new");
    openServerInfo("local");
    const stream = api.getPanel("stream:local:orders.new");
    const server = api.getPanel("server:local");

    closeEditorsForConn("local");
    expect(stream?.api.close).toHaveBeenCalled();
    expect(server?.api.close).toHaveBeenCalled();
    expect(
      useStream.getState().sessions["stream:local:orders.new"],
    ).toBeUndefined();
    expect(mocks.unsubscribe).toHaveBeenCalled();
  });

  it("tears down a connection's background stream sessions (no open panel)", async () => {
    // Streams persist across context switches, so a connection can have a live
    // session with no panel in the shown layout; conn loss must still close it
    // from the store, not only via open tabs.
    await useStream.getState().open("stream:remote:bg", "remote", "bg");
    expect(useStream.getState().sessions["stream:remote:bg"]).toBeDefined();
    expect(api.getPanel("stream:remote:bg")).toBeUndefined();

    closeEditorsForConn("remote");
    expect(useStream.getState().sessions["stream:remote:bg"]).toBeUndefined();
  });

  it("republishing into an open tab updates its params, not a new tab", () => {
    openPublish("local");
    expect(api.addPanel).toHaveBeenCalledTimes(1);

    openPublish("local", "orders.created", '{"a":1}');
    const panel = api.getPanel("publish:local");
    expect(api.addPanel).toHaveBeenCalledTimes(1);
    expect(panel?.api.updateParameters).toHaveBeenCalled();
    expect(panel?.params).toMatchObject({
      connId: "local",
      subject: "orders.created",
      payload: '{"a":1}',
      type: "publish",
    });
  });

  it("opening publish without a prefill does not clobber the open tab", () => {
    openPublish("local", "orders.created", "draft");
    const panel = api.getPanel("publish:local");
    openPublish("local");
    expect(panel?.api.updateParameters).not.toHaveBeenCalled();
    expect(panel?.params).toMatchObject({ subject: "orders.created" });
  });

  it("tears down sessions via the no-UI fallback when no editor api is set", async () => {
    setEditorApi(undefined as unknown as DockviewApi);
    await useStream.getState().open("stream:local:orphan", "local", "orphan");
    expect(useStream.getState().sessions["stream:local:orphan"]).toBeDefined();

    closeEditorsForConn("local");
    expect(
      useStream.getState().sessions["stream:local:orphan"],
    ).toBeUndefined();
    expect(mocks.unsubscribe).toHaveBeenCalled();
  });
});
