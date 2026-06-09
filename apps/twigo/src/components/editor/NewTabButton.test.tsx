import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useConnections } from "@/store/connections";
import { NewTabButton } from "./NewTabButton";

const { newPublish } = vi.hoisted(() => ({ newPublish: vi.fn() }));
vi.mock("@/lib/actions", () => ({ newPublish }));

function setLive(live: boolean) {
  useConnections.setState({
    connected: live
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

describe("NewTabButton", () => {
  beforeEach(() => {
    newPublish.mockReset();
  });
  afterEach(cleanup);

  it("is disabled with no live connection", () => {
    setLive(false);
    render(<NewTabButton />);
    expect(screen.getByRole("button", { name: /new publish/i })).toBeDisabled();
  });

  it("opens a publish tab when clicked", async () => {
    setLive(true);
    render(<NewTabButton />);
    await userEvent.click(screen.getByRole("button", { name: /new publish/i }));
    expect(newPublish).toHaveBeenCalledOnce();
  });
});
