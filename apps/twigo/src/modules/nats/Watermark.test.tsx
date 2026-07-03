import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("@/store/connections", async () => {
  const { create } = await import("zustand");
  const useConnections = create(() => ({
    status: "ready",
    contexts: [] as string[],
    connected: {},
    load: vi.fn(() => Promise.resolve()),
  }));
  return { useConnections };
});
vi.mock("@/components/connections/ConnectionForm", async () => {
  const React = await import("react");
  return {
    ConnectionForm: () =>
      React.createElement("div", { "data-testid": "connection-form" }),
  };
});
vi.mock("@/shell/editorHost", () => ({ openSettings: vi.fn() }));
vi.mock("@/lib/commands", () => ({ fmtBinding: () => "" }));
vi.mock("@/lib/actions", () => ({ newPublish: vi.fn() }));
vi.mock("@/store/palette", async () => {
  const { create } = await import("zustand");
  return { usePalette: create(() => ({ setOpen: vi.fn() })) };
});

import { NatsWatermark } from "./Watermark";
import { useConnections } from "@/store/connections";
import { useSettings } from "@/store/settings";

afterEach(cleanup);

describe("NatsWatermark (no contexts)", () => {
  beforeEach(() => {
    useConnections.setState({ status: "ready", contexts: [], connected: {} });
    useSettings.setState({ includeDemo: false });
  });

  it("opens the in-app connection form as the primary action", () => {
    render(<NatsWatermark />);
    fireEvent.click(screen.getByRole("button", { name: /Add connection/ }));
    expect(screen.getByTestId("connection-form")).toBeInTheDocument();
  });

  it("enables the demo server and reloads contexts", () => {
    render(<NatsWatermark />);
    fireEvent.click(
      screen.getByRole("button", { name: /Try the public demo server/ }),
    );
    expect(useSettings.getState().includeDemo).toBe(true);
    expect(useConnections.getState().load).toHaveBeenCalled();
  });
});
