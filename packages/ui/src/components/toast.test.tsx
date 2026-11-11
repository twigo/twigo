import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, expect, test, vi } from "vitest";
import { CircleCheck, Trash2 } from "lucide-react";
import { notify } from "./notify";
import { CountdownToast, Toast, Toaster } from "./toast";

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
      action={{ label: "Cancel", keys: "⌘Z", run }}
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

test("a countdown's toast cannot be swiped away, and dismissing it cancels it", async () => {
  vi.useFakeTimers();
  render(<Toaster />);
  const run = vi.fn();
  act(() => {
    notify.countdown({
      icon: Trash2,
      message: "Deleting pod web-1",
      detail: () => "dev · sends in 5 s",
      until: Date.now() + 5000,
      seconds: 5,
      action: { label: "Cancel", run },
    });
  });
  await act(() => vi.advanceTimersByTimeAsync(100));
  const shown = document.querySelector("[data-sonner-toast]");
  expect(shown?.getAttribute("data-dismissible")).toBe("false");
  expect(run).not.toHaveBeenCalled();
  act(() => {
    toast.dismiss();
  });
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(run).toHaveBeenCalledOnce();
  vi.useRealTimers();
});

test("an undo's toast runs it and stays for its owner to end, as long as the undo lasts", async () => {
  vi.useFakeTimers();
  render(<Toaster />);
  const custom = vi.spyOn(toast, "custom");
  const dismiss = vi.spyOn(toast, "dismiss");
  const run = vi.fn();
  act(() => {
    notify.undoable({
      icon: CircleCheck,
      message: "Scaled deployment web to 5",
      detail: (left) => `dev · undo for ${String(left)} s`,
      until: Date.now() + 30_000,
      seconds: 30,
      action: { label: "Undo", keys: "⌘Z", run },
    });
  });
  expect(custom).toHaveBeenCalledWith(expect.any(Function), {
    duration: 30_000,
  });
  await act(() => vi.advanceTimersByTimeAsync(100));
  expect(screen.getByRole("status").textContent).toContain(
    "dev · undo for 30 s",
  );
  fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
  expect(run).toHaveBeenCalledOnce();
  expect(dismiss).not.toHaveBeenCalled();
  vi.useRealTimers();
});

test("a choice's toast stays until its owner dismisses it, takes one answer, and shows new words under the same key", async () => {
  vi.useFakeTimers();
  render(<Toaster />);
  const first = vi.fn();
  const second = vi.fn();
  const choices = (move: () => void) => [
    { label: "Move", run: move },
    { label: "Dismiss", run: second },
  ];
  let shown: { dismiss: () => void } | undefined;
  act(() => {
    shown = notify.choice(
      {
        icon: CircleCheck,
        message: "Terminal 1 added a context",
        choices: choices(first),
      },
      "offer-1",
    );
  });
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(
    document
      .querySelector("[data-sonner-toast]")
      ?.getAttribute("data-dismissible"),
  ).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Move" }));
  expect(first).toHaveBeenCalledOnce();

  act(() => {
    notify.choice(
      {
        icon: CircleCheck,
        message: "Terminal 1 added two contexts",
        choices: choices(first),
        busy: true,
      },
      "offer-1",
    );
  });
  await act(() => vi.advanceTimersByTimeAsync(100));
  expect(screen.getAllByRole("status")).toHaveLength(1);
  screen.getByText("Terminal 1 added two contexts");
  expect(
    screen.getByRole("button", { name: "Move" }).hasAttribute("disabled"),
  ).toBe(true);

  act(() => {
    shown?.dismiss();
  });
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(
    document.querySelector("[data-sonner-toast]")?.getAttribute("data-removed"),
  ).toBe("true");
  vi.useRealTimers();
});

test("the toaster keeps its toasts above the clearance it is given, and at the status bar's edge with none", async () => {
  vi.useFakeTimers();
  const { rerender } = render(<Toaster />);
  act(() => {
    notify.warning("Held");
  });
  await act(() => vi.advanceTimersByTimeAsync(100));
  const bottom = () =>
    document
      .querySelector<HTMLElement>("[data-sonner-toaster]")
      ?.style.getPropertyValue("--offset-bottom");
  expect(bottom()).toBe("32px");
  rerender(<Toaster clearance={284} />);
  expect(bottom()).toBe("316px");
  rerender(<Toaster clearance={0} />);
  expect(bottom()).toBe("32px");
  act(() => {
    toast.dismiss();
  });
  await act(() => vi.advanceTimersByTimeAsync(1000));
  vi.useRealTimers();
});
