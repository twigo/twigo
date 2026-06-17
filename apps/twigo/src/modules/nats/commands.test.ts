import { describe, it, expect, beforeEach, vi } from "vitest";
import { useConnections } from "@/store/connections";
import type { ContextSummary, ConnInfo } from "@/lib/api";
import { getCommands } from "@/lib/commands";
import { registerNatsCommands } from "./commands";

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
function info(name: string, jetstream = false): ConnInfo {
  return {
    name,
    serverName: "s",
    serverVersion: "2",
    rttMs: 0,
    jetstream,
    maxPayload: 0,
    connected: true,
  };
}

// Contributes publish/responder/refresh + per-context connect commands into the
// shared command registry that getCommands() reads.
registerNatsCommands();

describe("nats commands", () => {
  beforeEach(() => {
    useConnections.setState({
      connected: {},
      contexts: [],
      activeContext: null,
    });
  });

  it("gates create commands behind a live connection", () => {
    expect(getCommands().some((c) => c.id === "publish.new")).toBe(false);
    useConnections.setState({ connected: { a: info("a") } });
    expect(getCommands().some((c) => c.id === "publish.new")).toBe(true);
  });

  it("gates JetStream refresh behind a jetstream-enabled connection", () => {
    useConnections.setState({
      activeContext: "a",
      connected: { a: info("a", false) },
    });
    expect(getCommands().some((c) => c.id === "jetstream.refresh")).toBe(false);
    useConnections.setState({ connected: { a: info("a", true) } });
    expect(getCommands().some((c) => c.id === "jetstream.refresh")).toBe(true);
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
});
