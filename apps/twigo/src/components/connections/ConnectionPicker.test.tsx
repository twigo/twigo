import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useConnections } from "@/store/connections";
import type { ConnInfo, ContextSummary } from "@/lib/api";
import { ConnectionPicker } from "./ConnectionPicker";

vi.mock("@/lib/editor", () => ({ openServerInfo: vi.fn() }));

const setActive = vi.fn();
const connect = vi.fn();
const disconnect = vi.fn();
const load = vi.fn();

function ctx(name: string): ContextSummary {
  return {
    name,
    description: "",
    url: `nats://${name}:4222`,
    authMethod: "none",
    hasTls: false,
    monitoringUrl: null,
    selected: false,
  };
}

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

describe("ConnectionPicker", () => {
  beforeEach(() => {
    setActive.mockReset();
    connect.mockReset();
    disconnect.mockReset();
    useConnections.setState({
      contexts: [ctx("prod-eu"), ctx("dev-local")],
      connected: { "prod-eu": info("prod-eu") },
      connecting: {},
      connError: {},
      activeContext: "prod-eu",
      setActive,
      connect,
      disconnect,
      load,
    });
  });
  afterEach(cleanup);

  it("groups live and available connections", () => {
    render(<ConnectionPicker onClose={() => undefined} />);
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("Available")).toBeInTheDocument();
    expect(screen.getByText("prod-eu")).toBeInTheDocument();
    expect(screen.getByText("dev-local")).toBeInTheDocument();
  });

  it("activates a connected connection and closes", async () => {
    const onClose = vi.fn();
    render(<ConnectionPicker onClose={onClose} />);
    await userEvent.click(screen.getByText("prod-eu"));
    expect(setActive).toHaveBeenCalledWith("prod-eu");
    expect(onClose).toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("connects a disconnected connection on select", async () => {
    render(<ConnectionPicker onClose={() => undefined} />);
    await userEvent.click(screen.getByText("dev-local"));
    expect(connect).toHaveBeenCalledWith("dev-local");
    expect(setActive).toHaveBeenCalledWith("dev-local");
  });

  it("disconnects from the inline action", async () => {
    render(<ConnectionPicker onClose={() => undefined} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Disconnect prod-eu" }),
    );
    expect(disconnect).toHaveBeenCalledWith("prod-eu");
    expect(setActive).not.toHaveBeenCalled();
  });
});
