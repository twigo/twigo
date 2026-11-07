import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Trash2 } from "lucide-react";
import { afterEach, expect, test, vi } from "vitest";
import { ConfirmDialog } from "./confirm-dialog";

afterEach(() => {
  cleanup();
});

function dialog(typed?: string) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      question="Delete namespace payments from prod-eu?"
      consequences={["Every object in it goes with it."]}
      command="kubectl --context prod-eu delete namespaces payments"
      {...(typed !== undefined && { typed })}
      confirm="Delete namespace"
      icon={Trash2}
      destructive
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel };
}

test("the button names its action and waits for the name typed exactly", () => {
  const { onConfirm } = dialog("payments");
  const button = screen.getByRole("button", { name: "Delete namespace" });
  const field = screen.getByLabelText("Type payments to confirm");
  expect(document.activeElement).toBe(field);
  expect(button).toHaveProperty("disabled", true);
  for (const wrong of ["payment", "Payments", "payments "]) {
    fireEvent.change(field, { target: { value: wrong } });
    expect(button).toHaveProperty("disabled", true);
    fireEvent.submit(field);
  }
  expect(onConfirm).not.toHaveBeenCalled();
  fireEvent.change(field, { target: { value: "payments" } });
  expect(button).toHaveProperty("disabled", false);
  fireEvent.click(button);
  expect(onConfirm).toHaveBeenCalledWith("payments");
});

test("focus starts on Cancel, so a stray Enter confirms nothing", () => {
  const { onConfirm, onCancel } = dialog();
  const cancel = screen.getByRole("button", { name: /Cancel/ });
  expect(document.activeElement).toBe(cancel);
  fireEvent.click(cancel);
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onConfirm).not.toHaveBeenCalled();
  expect(
    screen.getByText("kubectl --context prod-eu delete namespaces payments"),
  ).toBeTruthy();
  expect(screen.getByText("Every object in it goes with it.")).toBeTruthy();
});

test("Escape cancels", () => {
  const { onCancel } = dialog("payments");
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
  });
  expect(onCancel).toHaveBeenCalledOnce();
});
