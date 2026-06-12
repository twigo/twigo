import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ContextSummary, ConnInfo } from "@/lib/api";

const { listContexts, connect, disconnect, connInfo } = vi.hoisted(() => ({
  listContexts: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  connInfo: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ listContexts, connect, disconnect, connInfo }));
vi.mock("@/lib/editor", () => ({ closeEditorsForConn: vi.fn() }));

import { useConnections } from "./connections";
import { useWorkspace } from "./workspace";

function ctx(name: string, selected = false): ContextSummary {
  return {
    name,
    description: "",
    url: `nats://${name}:4222`,
    authMethod: "none",
    hasTls: false,
    selected,
  };
}

function info(name = "a"): ConnInfo {
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

describe("connections active-context persistence", () => {
  beforeEach(() => {
    listContexts.mockReset();
    useWorkspace.setState({
      activeContext: null,
      lastConnected: [],
      watching: {},
    });
    useConnections.setState({
      activeContext: null,
      contexts: [],
      status: "idle",
    });
  });

  it("persists the active context to the workspace on setActive", () => {
    useConnections.getState().setActive("prod-eu");
    expect(useConnections.getState().activeContext).toBe("prod-eu");
    expect(useWorkspace.getState().activeContext).toBe("prod-eu");
  });

  it("restores the remembered active context on load over the nats-selected one", async () => {
    useWorkspace.setState({ activeContext: "prod-us" });
    listContexts.mockResolvedValue([ctx("prod-eu", true), ctx("prod-us")]);
    await useConnections.getState().load();
    expect(useConnections.getState().activeContext).toBe("prod-us");
  });

  it("falls back to the nats-selected context when the remembered one is gone", async () => {
    useWorkspace.setState({ activeContext: "deleted" });
    listContexts.mockResolvedValue([ctx("prod-eu", true)]);
    await useConnections.getState().load();
    expect(useConnections.getState().activeContext).toBe("prod-eu");
  });

  it("prunes persisted state for contexts that disappeared, on load", async () => {
    useWorkspace.setState({
      layouts: { gone: {} as never },
      lastConnected: ["gone"],
      watching: { gone: ">" },
      activeContext: "gone",
    });
    listContexts.mockResolvedValue([ctx("prod-eu", true)]);
    await useConnections.getState().load();
    const w = useWorkspace.getState();
    expect(w.layouts.gone).toBeUndefined();
    expect(w.lastConnected).toEqual([]);
    expect(w.activeContext).not.toBe("gone");
  });

  it("marks a connection reconnecting on a disconnected event", () => {
    useConnections.setState({
      connected: { a: { ...info(), connected: true } },
    });
    useConnections.getState().onEvent("a", "disconnected");
    expect(useConnections.getState().connected.a?.connected).toBe(false);
  });

  it("drops a connection on a closed event", () => {
    useConnections.setState({ connected: { a: info() } });
    useConnections.getState().onEvent("a", "closed");
    expect(useConnections.getState().connected.a).toBeUndefined();
  });

  it("tracks reconnect backoff and clears it once connected", () => {
    useConnections.setState({ reconnecting: {} });
    useConnections.getState().onReconnect("a", 3, 2000);
    const rc = useConnections.getState().reconnecting.a;
    expect(rc?.attempt).toBe(3);
    expect(rc?.delayMs).toBe(2000);

    connInfo.mockResolvedValue(info("a"));
    useConnections.getState().onEvent("a", "connected");
    expect(useConnections.getState().reconnecting.a).toBeUndefined();
  });
});
