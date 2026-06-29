import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  act,
} from "@testing-library/react";
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
    render(
      <PublishEditor
        connId="c"
        initialSubject="orders.created"
        initialPayload="hello"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(publish).toHaveBeenCalledWith("c", "orders.created", "hello", []);
  });

  it("disables sending when the connection is not live", () => {
    setLive(false);
    render(<PublishEditor connId="c" initialSubject="orders.created" />);
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Request" })).toBeDisabled();
  });

  // Click Publish and flush the microtask that resolves the mocked publish, so
  // the "Published" flash (set after the await) and its timer are registered.
  const clickPublish = () =>
    act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Publish" }));
      await Promise.resolve();
    });

  it("clears the published flash after the timeout window", async () => {
    vi.useFakeTimers();
    try {
      setLive(true);
      publish.mockResolvedValue(undefined);
      render(
        <PublishEditor connId="c" initialSubject="s" initialPayload="x" />,
      );
      await clickPublish();
      expect(screen.getByText("Published")).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      expect(screen.queryByText("Published")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the flash window when publishing again before it expires", async () => {
    vi.useFakeTimers();
    try {
      setLive(true);
      publish.mockResolvedValue(undefined);
      render(
        <PublishEditor connId="c" initialSubject="s" initialPayload="x" />,
      );

      await clickPublish();
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      await clickPublish();
      // 2000ms after the first publish, only 1000ms after the second: still shown.
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByText("Published")).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(screen.queryByText("Published")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the pending flash timer on unmount", async () => {
    vi.useFakeTimers();
    try {
      setLive(true);
      publish.mockResolvedValue(undefined);
      const { unmount } = render(
        <PublishEditor connId="c" initialSubject="s" initialPayload="x" />,
      );
      await clickPublish();
      const clearSpy = vi.spyOn(globalThis, "clearTimeout");
      unmount();
      expect(clearSpy).toHaveBeenCalled();
      clearSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});
