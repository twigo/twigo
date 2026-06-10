import { describe, it, expect, beforeEach, vi } from "vitest";
import { useConnections } from "@/store/connections";
import type { ContextSummary, ConnInfo } from "@/lib/api";
import { getCommands, matchKeybinding, fmtBinding } from "./commands";

vi.mock("@/lib/editor", () => ({
  openSettings: vi.fn(),
  openStream: vi.fn(),
  openPublish: vi.fn(),
  openResponder: vi.fn(),
  openResponderTab: vi.fn(),
  openServerInfo: vi.fn(),
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
