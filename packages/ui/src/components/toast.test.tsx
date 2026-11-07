import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, expect, test, vi } from "vitest";
import { Trash2 } from "lucide-react";
import { CountdownToast, Toast } from "./toast";

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

test("a countdown says the seconds left and its Cancel runs", () => {
  vi.useFakeTimers();
  const run = vi.fn();
  render(
    <CountdownToast
      icon={Trash2}
      message="Deleting pod web-1"
      detail={(left) => `dev · sends in ${String(left)} s`}
      until={Date.now() + 5000}
      seconds={5}
      cancel={{ label: "Cancel", keys: "⌘Z", run }}
    />,
  );
  expect(screen.getByRole("status").textContent).toContain("sends in 5 s");
  act(() => {
    vi.advanceTimersByTime(2100);
  });
  expect(screen.getByRole("status").textContent).toContain("sends in 3 s");
  fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
  expect(run).toHaveBeenCalledOnce();
  vi.useRealTimers();
});
