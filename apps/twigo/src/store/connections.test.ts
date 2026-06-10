import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ContextSummary } from "@/lib/api";

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
});
