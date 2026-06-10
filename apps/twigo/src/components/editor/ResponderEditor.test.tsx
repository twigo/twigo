import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render as renderUi, screen, cleanup } from "@testing-library/react";
import { useConnections } from "@/store/connections";
import { useResponder } from "@/store/responder";
import { ResponderEditor } from "./ResponderEditor";

vi.mock("@/lib/template", () => ({
  render: vi.fn().mockResolvedValue({ ok: true, output: "{}" }),
  buildMsgContext: (m: unknown) => m,
  warmUp: vi.fn(),
}));

function setLive(connected: boolean) {
  useConnections.setState({
    connected: connected
      ? {
          conn: {
            name: "conn",
            serverName: "s",
            serverVersion: "2",
            rttMs: 0,
            jetstream: false,
            maxPayload: 0,
            connected: true,
          },
        }
      : {},
  });
}

describe("ResponderEditor", () => {
  beforeEach(() => {
    useResponder.setState({ byConn: {} });
  });
  afterEach(cleanup);

  it("renders the form with the seeded subject", () => {
    setLive(true);
    renderUi(
      <ResponderEditor id="r1" connId="conn" initialSubject="orders.get" />,
    );
    expect(screen.getByLabelText("Listen on subject")).toHaveValue(
      "orders.get",
    );
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
  });

  it("disables Start when the connection is not live", () => {
    setLive(false);
    renderUi(
      <ResponderEditor id="r1" connId="conn" initialSubject="orders.get" />,
    );
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  });
});
