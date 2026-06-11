import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ConfirmDialog } from "./ConfirmDialog";

afterEach(cleanup);

describe("ConfirmDialog", () => {
  it("gates confirm behind typing the confirm word", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={() => undefined}
        title="Delete stream ORDERS?"
        description="irreversible"
        confirmLabel="Delete stream"
        confirmWord="ORDERS"
        onConfirm={onConfirm}
      />,
    );

    const confirm = screen.getByRole("button", { name: "Delete stream" });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Type to confirm"), {
      target: { value: "ORDERS" },
    });
    expect(confirm).not.toBeDisabled();

    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("confirms immediately when no confirm word is required", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={() => undefined}
        title="Delete consumer worker?"
        description="removes the consumer"
        confirmLabel="Delete consumer"
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete consumer" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
