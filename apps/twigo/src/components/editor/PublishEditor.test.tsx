import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useConnections } from "@/store/connections";
import { PublishEditor } from "./PublishEditor";

const { publish, request } = vi.hoisted(() => ({
  publish: vi.fn(),
  request: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ publish, request }));

function setLive(connected: boolean) {
  useConnections.setState({
    connected: connected
      ? {
          c: {
            name: "c",
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

describe("PublishEditor", () => {
  beforeEach(() => {
    publish.mockReset();
    request.mockReset();
  });
  afterEach(cleanup);

  it("publishes the subject and payload", async () => {
    setLive(true);
    render(<PublishEditor connId="c" initialSubject="orders.created" />);
    await userEvent.type(screen.getByLabelText("Payload"), "hello");
    await userEvent.click(screen.getByRole("button", { name: /publish/i }));
    expect(publish).toHaveBeenCalledWith("c", "orders.created", "hello");
  });

  it("disables sending when the connection is not live", () => {
    setLive(false);
    render(<PublishEditor connId="c" initialSubject="orders.created" />);
    expect(screen.getByRole("button", { name: /publish/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /request/i })).toBeDisabled();
  });
});
