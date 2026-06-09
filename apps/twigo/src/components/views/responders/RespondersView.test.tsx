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

function setLive() {
  useConnections.setState({
    connected: {
      conn: {
        name: "conn",
        serverName: "s",
        serverVersion: "2",
        rttMs: 0,
        jetstream: false,
        maxPayload: 0,
        connected: true,
      },
    },
  });
}

describe("RespondersView", () => {
  beforeEach(() => {
    useResponder.setState({ sessions: {} });
    useConnections.setState({ connected: {} });
  });
  afterEach(cleanup);

  it("shows an empty state when there are no responders", () => {
    render(<RespondersView filter="" />);
    expect(screen.getByText(/No responders yet/i)).toBeInTheDocument();
  });

  it("lists a responder with its subject and a Start action", () => {
    setLive();
    useResponder.getState().ensure("r1", "conn", "orders.get");
    render(<RespondersView filter="" />);
    expect(screen.getByText("orders.get")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start responder" }),
    ).toBeEnabled();
  });

  it("filters by subject", () => {
    useResponder.getState().ensure("r1", "conn", "orders.get");
    useResponder.getState().ensure("r2", "conn", "users.create");
    render(<RespondersView filter="users" />);
    expect(screen.queryByText("orders.get")).not.toBeInTheDocument();
    expect(screen.getByText("users.create")).toBeInTheDocument();
  });
});
