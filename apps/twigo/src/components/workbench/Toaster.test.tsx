import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Toaster } from "./Toaster";
import { useToasts, type Toast, type ToastKind } from "@/store/toasts";

function mk(
  partial: Partial<Toast> & { kind: ToastKind; message: string },
): Toast {
  return {
    id: partial.id ?? 1,
    kind: partial.kind,
    message: partial.message,
    action: partial.action,
    key: partial.key ?? `${partial.kind}|${partial.message}`,
    count: partial.count ?? 1,
    ttl: partial.ttl ?? 6000,
    leaving: partial.leaving ?? false,
  };
}

function seed(toasts: Toast[]) {
  useToasts.setState({ toasts, queue: [] });
}

describe("Toaster", () => {
  beforeEach(() => {
    useToasts.setState({ toasts: [], queue: [] });
  });
  afterEach(cleanup);

  it("renders a toast message with a status role for routine outcomes", () => {
    seed([mk({ kind: "success", message: "Published to orders.created." })]);
    render(<Toaster />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Published to orders.created.",
    );
  });

  it("uses an assertive alert role for errors", () => {
    seed([mk({ kind: "error", message: "Connect failed" })]);
    render(<Toaster />);
    expect(screen.getByRole("alert")).toHaveTextContent("Connect failed");
  });

  it("shows a coalesce count badge only when count > 1", () => {
    seed([mk({ id: 1, kind: "warning", message: "slow", count: 4 })]);
    const { rerender } = render(<Toaster />);
    expect(screen.getByText("×4")).toBeInTheDocument();

    seed([mk({ id: 2, kind: "warning", message: "slow", count: 1 })]);
    rerender(<Toaster />);
    expect(screen.queryByText(/^×/)).not.toBeInTheDocument();
  });

  it("renders no action button when the toast has no action", () => {
    seed([mk({ kind: "info", message: "Reconnected" })]);
    render(<Toaster />);
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("runs the action and dismisses when its button is clicked", () => {
    const run = vi.fn();
    seed([
      mk({
        id: 7,
        kind: "error",
        message: "Connect failed",
        action: { label: "Retry", run },
      }),
    ]);
    render(<Toaster />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(run).toHaveBeenCalledOnce();
    expect(useToasts.getState().toasts[0]?.leaving).toBe(true);
  });

  it("starts dismissing when the close button is clicked", () => {
    seed([mk({ id: 9, kind: "warning", message: "Slow consumer" })]);
    render(<Toaster />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(useToasts.getState().toasts[0]?.leaving).toBe(true);
  });
});
