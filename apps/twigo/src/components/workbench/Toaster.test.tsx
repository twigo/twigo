import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Toaster } from "./Toaster";
import { useToasts, type Toast } from "@/store/toasts";

function seed(toasts: Toast[]) {
  useToasts.setState({ toasts });
}

describe("Toaster", () => {
  beforeEach(() => {
    useToasts.setState({ toasts: [] });
  });
  afterEach(cleanup);

  it("renders a toast message with a status role", () => {
    seed([{ id: 1, kind: "success", message: "Published to orders.created." }]);
    render(<Toaster />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Published to orders.created.",
    );
  });

  it("renders no action button when the toast has no action", () => {
    seed([{ id: 1, kind: "info", message: "Reconnected" }]);
    render(<Toaster />);
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("runs the action and dismisses when its button is clicked", () => {
    const run = vi.fn();
    seed([
      {
        id: 7,
        kind: "error",
        message: "Connect failed",
        action: { label: "Retry", run },
      },
    ]);
    render(<Toaster />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(run).toHaveBeenCalledOnce();
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it("dismisses when the close button is clicked", () => {
    seed([{ id: 9, kind: "warning", message: "Slow consumer" }]);
    render(<Toaster />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(useToasts.getState().toasts).toHaveLength(0);
  });
});
