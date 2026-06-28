import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getContext, saveContext } from "@/lib/api";
import { useConnections } from "@/store/connections";
import { useSettings } from "@/store/settings";
import { ConnectionForm } from "./ConnectionForm";

vi.mock("@/lib/api", () => ({
  getContext: vi.fn(),
  saveContext: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const load = vi.fn(() => Promise.resolve());
const removeContext = vi.fn(() => Promise.resolve());

beforeEach(() => {
  vi.mocked(getContext).mockReset();
  vi.mocked(saveContext).mockClear();
  load.mockClear();
  removeContext.mockClear();
  useConnections.setState({ load, removeContext });
  useSettings.setState({ contextDir: null });
});
afterEach(cleanup);

describe("ConnectionForm", () => {
  it("creates a context with the entered name + url", async () => {
    const onClose = vi.fn();
    render(<ConnectionForm onClose={onClose} />);

    await userEvent.type(screen.getByPlaceholderText("prod-eu"), "newconn");
    await userEvent.type(
      screen.getByPlaceholderText("nats://localhost:4222"),
      "nats://x:4222",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /create connection/i }),
    );

    await waitFor(() => expect(saveContext).toHaveBeenCalled());
    expect(saveContext).toHaveBeenCalledWith(
      null,
      "newconn",
      expect.objectContaining({ url: "nats://x:4222", tlsFirst: false }),
    );
    expect(load).toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("blocks submit on an invalid name", async () => {
    render(<ConnectionForm onClose={vi.fn()} />);
    await userEvent.type(screen.getByPlaceholderText("prod-eu"), "bad name");
    await userEvent.type(
      screen.getByPlaceholderText("nats://localhost:4222"),
      "nats://x:4222",
    );
    expect(
      screen.getByRole("button", { name: /create connection/i }),
    ).toBeDisabled();
    expect(screen.getByText(/letters, digits/i)).toBeInTheDocument();
  });

  it("pre-fills from the loaded context in edit mode", async () => {
    vi.mocked(getContext).mockResolvedValue({
      name: "prod",
      url: "nats://prod:4222",
      description: "",
      token: "s3cr3t",
      tlsFirst: false,
    });
    render(<ConnectionForm editName="prod" onClose={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByDisplayValue("nats://prod:4222")).toBeInTheDocument(),
    );
    expect(getContext).toHaveBeenCalledWith(null, "prod");
    // Token auth derived from the prefilled secret.
    expect(screen.getByDisplayValue("s3cr3t")).toBeInTheDocument();
  });

  it("deletes a context after confirming", async () => {
    vi.mocked(getContext).mockResolvedValue({
      name: "old",
      url: "nats://old:4222",
      description: "",
      tlsFirst: false,
    });
    const onClose = vi.fn();
    render(<ConnectionForm editName="old" onClose={onClose} />);
    await waitFor(() =>
      expect(screen.getByDisplayValue("nats://old:4222")).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await userEvent.click(screen.getByRole("button", { name: /^delete$/i })); // confirm

    // removeContext (store) disconnects a live conn before deleting the file.
    await waitFor(() => expect(removeContext).toHaveBeenCalledWith("old"));
  });
});
