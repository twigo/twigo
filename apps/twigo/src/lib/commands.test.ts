import { describe, it, expect, beforeEach, vi } from "vitest";
import { useConnections } from "@/store/connections";
import type { ContextSummary, ConnInfo } from "@/lib/api";
import { getCommands, matchKeybinding, fmtBinding } from "./commands";
import { canSplitActiveEditor, editorGroupCount } from "@/lib/editor";

vi.mock("@/lib/editor", () => ({
  openSettings: vi.fn(),
  openStream: vi.fn(),
  openPublish: vi.fn(),
  openResponder: vi.fn(),
  openResponderTab: vi.fn(),
  openServerInfo: vi.fn(),
  splitActiveEditor: vi.fn(),
  focusNextEditorGroup: vi.fn(),
  resetEditorLayout: vi.fn(),
  canSplitActiveEditor: vi.fn(() => false),
  editorGroupCount: vi.fn(() => 0),
}));
vi.mock("@/lib/actions", () => ({
  newPublish: vi.fn(),
  newResponder: vi.fn(),
}));

function ctx(name: string): ContextSummary {
  return {
    name,
    description: "",
    url: `nats://${name}:4222`,
    authMethod: "none",
    hasTls: false,
    selected: false,
  };
}
function info(name: string): ConnInfo {
  return {
    name,
    serverName: "s",
    serverVersion: "2",
    rttMs: 0,
    jetstream: false,
    maxPayload: 0,
    connected: true,
  };
}

const ev = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("command registry", () => {
  beforeEach(() => {
    useConnections.setState({ connected: {}, contexts: [] });
  });

  it("gates create commands behind a live connection", () => {
    expect(getCommands().some((c) => c.id === "publish.new")).toBe(false);
    useConnections.setState({ connected: { a: info("a") } });
    expect(getCommands().some((c) => c.id === "publish.new")).toBe(true);
  });

  it("gates editor split commands behind a splittable layout", () => {
    vi.mocked(canSplitActiveEditor).mockReturnValue(false);
    expect(getCommands().some((c) => c.id === "editor.splitRight")).toBe(false);
    vi.mocked(canSplitActiveEditor).mockReturnValue(true);
    const split = getCommands().find((c) => c.id === "editor.splitRight");
    expect(split).toBeDefined();
    expect(split?.keybinding).toBe("mod+\\");
    vi.mocked(canSplitActiveEditor).mockReturnValue(false);
  });

  it("gates focus/reset commands behind multiple editor groups", () => {
    vi.mocked(editorGroupCount).mockReturnValue(0);
    expect(getCommands().some((c) => c.id === "editor.resetLayout")).toBe(
      false,
    );
    vi.mocked(editorGroupCount).mockReturnValue(2);
    expect(getCommands().some((c) => c.id === "editor.resetLayout")).toBe(true);
    vi.mocked(editorGroupCount).mockReturnValue(0);
  });

  it("generates connect/switch commands per context", () => {
    useConnections.setState({ contexts: [ctx("prod-eu")], connected: {} });
    expect(getCommands().find((c) => c.id === "conn.prod-eu")?.title).toBe(
      "Connect to prod-eu",
    );
    useConnections.setState({ connected: { "prod-eu": info("prod-eu") } });
    expect(getCommands().find((c) => c.id === "conn.prod-eu")?.title).toBe(
      "Switch to prod-eu",
    );
  });

  it("connecting to a context also makes it active", () => {
    useConnections.setState({
      contexts: [ctx("prod-eu")],
      connected: {},
      activeContext: null,
    });
    getCommands()
      .find((c) => c.id === "conn.prod-eu")
      ?.run();
    expect(useConnections.getState().activeContext).toBe("prod-eu");
  });

  it("always offers the view-navigation commands", () => {
    const ids = getCommands().map((c) => c.id);
    expect(ids).toContain("view.subjects");
    expect(ids).toContain("view.responders");
  });

  it("binds settings to the conventional mod+,", () => {
    expect(
      getCommands().find((c) => c.id === "settings.open")?.keybinding,
    ).toBe("mod+,");
  });
});

describe("matchKeybinding", () => {
  it("treats meta and ctrl as the same mod", () => {
    expect(matchKeybinding(ev({ key: "n", metaKey: true }), "mod+n")).toBe(
      true,
    );
    expect(matchKeybinding(ev({ key: "n", ctrlKey: true }), "mod+n")).toBe(
      true,
    );
    expect(matchKeybinding(ev({ key: "n" }), "mod+n")).toBe(false);
  });

  it("requires the exact modifier set", () => {
    expect(
      matchKeybinding(ev({ key: "n", metaKey: true, altKey: true }), "mod+n"),
    ).toBe(false);
    expect(
      matchKeybinding(
        ev({ key: "b", metaKey: true, altKey: true }),
        "mod+alt+b",
      ),
    ).toBe(true);
    expect(matchKeybinding(ev({ key: "b", metaKey: true }), "mod+alt+b")).toBe(
      false,
    );
  });
});

describe("fmtBinding", () => {
  it("renders a readable shortcut", () => {
    expect(fmtBinding("mod+n")).toMatch(/(⌘|Ctrl\+)N/);
  });

  it("orders modifiers by platform convention (Command last on mac)", () => {
    expect(fmtBinding("mod+shift+p")).toMatch(/^(⇧⌘P|Ctrl\+Shift\+P)$/);
    expect(fmtBinding("mod+alt+b")).toMatch(/^(⌥⌘B|Ctrl\+Alt\+B)$/);
  });
});
