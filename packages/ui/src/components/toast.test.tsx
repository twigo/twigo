import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, expect, test, vi } from "vitest";
import { Toast } from "./toast";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("errors and warnings are announced assertively, the rest politely", () => {
  const { rerender } = render(
    <Toast id="t1" tone="error" message="Could not load." action={undefined} />,
  );
  expect(screen.getByRole("alert").textContent).toBe("Could not load.");
  rerender(
    <Toast id="t1" tone="warning" message="Stale." action={undefined} />,
  );
  expect(screen.getByRole("alert").textContent).toBe("Stale.");
  for (const tone of ["success", "info"] as const) {
    rerender(<Toast id="t1" tone={tone} message="Saved." action={undefined} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Saved.");
  }
});

test("the action runs and dismisses only its toast", () => {
  const dismiss = vi.spyOn(toast, "dismiss").mockReturnValue("t7");
  const run = vi.fn();
  render(
    <Toast
      id="t7"
      tone="error"
      message="Could not connect."
      action={{ label: "Retry", run }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(run).toHaveBeenCalledOnce();
  expect(dismiss).toHaveBeenCalledWith("t7");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(dismiss).toHaveBeenCalledTimes(2);
});
