import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { useConnections } from "@/store/connections";
import { useResponder } from "@/store/responder";
import { RespondersView } from "./RespondersView";

vi.mock("@/lib/template", () => ({
  render: vi.fn(),
  buildMsgContext: (m: unknown) => m,
  warmUp: vi.fn(),
}));
vi.mock("@/lib/editor", () => ({ openResponderTab: vi.fn() }));

function setLive(name: string) {
  useConnections.setState((s) => ({
    connected: {
      ...s.connected,
      [name]: {
        name,
        serverName: "s",
        serverVersion: "2",
        rttMs: 0,
        jetstream: false,
        maxPayload: 0,
        connected: true,
      },
    },
  }));
}

describe("RespondersView", () => {
  beforeEach(() => {
    useResponder.setState({ byConn: {} });
    useConnections.setState({ connected: {} });
  });
  afterEach(cleanup);

  it("prompts to connect when there is no active connection", () => {
    render(<RespondersView filter="" connId={null} />);
    expect(screen.getByText(/Connect to a server/i)).toBeInTheDocument();
  });

  it("shows a connection-specific empty state", () => {
    setLive("conn");
    render(<RespondersView filter="" connId="conn" />);
    expect(screen.getByText(/No responders for/i)).toBeInTheDocument();
  });

  it("lists a responder with its subject and a Start action", () => {
    setLive("conn");
    useResponder.getState().ensure("r1", "conn", "orders.get");
    render(<RespondersView filter="" connId="conn" />);
    expect(screen.getByText("orders.get")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start responder" }),
    ).toBeEnabled();
  });

  it("only shows responders for the active connection", () => {
    setLive("a");
    setLive("b");
    useResponder.getState().ensure("ra", "a", "orders.get");
    useResponder.getState().ensure("rb", "b", "users.create");
    render(<RespondersView filter="" connId="a" />);
    expect(screen.getByText("orders.get")).toBeInTheDocument();
    expect(screen.queryByText("users.create")).not.toBeInTheDocument();
  });

  it("filters by subject within the connection", () => {
    setLive("conn");
    useResponder.getState().ensure("r1", "conn", "orders.get");
    useResponder.getState().ensure("r2", "conn", "users.create");
    render(<RespondersView filter="users" connId="conn" />);
    expect(screen.queryByText("orders.get")).not.toBeInTheDocument();
    expect(screen.getByText("users.create")).toBeInTheDocument();
  });
});
