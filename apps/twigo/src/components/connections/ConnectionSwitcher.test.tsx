import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { useConnections } from "@/store/connections";
import type { ConnInfo } from "@/lib/api";
import { ConnectionSwitcher } from "./ConnectionSwitcher";

vi.mock("@/lib/editor", () => ({ openServerInfo: vi.fn() }));

function info(name: string): ConnInfo {
  return {
    name,
    serverName: "s",
    serverVersion: "2",
    rttMs: 1,
    jetstream: false,
    maxPayload: 0,
    connected: true,
  };
}

describe("ConnectionSwitcher", () => {
  beforeEach(() => {
    useConnections.setState({
      contexts: [],
      connected: { "prod-eu": info("prod-eu"), "prod-us": info("prod-us") },
      connecting: {},
      connError: {},
      activeContext: "prod-eu",
    });
  });
  afterEach(cleanup);

  it("shows the active connection and live count", () => {
    render(<ConnectionSwitcher />);
    expect(screen.getByText("prod-eu")).toBeInTheDocument();
    expect(screen.getByText("2 live")).toBeInTheDocument();
  });

  it("prompts to select when there is no active connection", () => {
    useConnections.setState({ activeContext: null, connected: {} });
    render(<ConnectionSwitcher />);
    expect(screen.getByText(/Select connection/i)).toBeInTheDocument();
  });
});
