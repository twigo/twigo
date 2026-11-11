import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { toast } from "sonner";
import { compile } from "tailwindcss";
import { afterEach, expect, test, vi } from "vitest";
import { CircleCheck, Trash2 } from "lucide-react";
import { notify } from "./notify";
import { ChoiceToast, CountdownToast, Toast, Toaster } from "./toast";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.querySelector("style[data-utilities]")?.remove();
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

const VIEWPORT = 760;

function measureToasts(heights: Readonly<Record<string, number>>) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const entry = Object.entries(heights).find(([text]) =>
        this.textContent.includes(text),
      );
      return { height: entry?.[1] ?? 0 } as DOMRect;
    },
  );
}

function bottomEdge(): number {
  const list = document.querySelector<HTMLElement>("[data-sonner-toaster]");
  const offset = list?.style.getPropertyValue("--offset-bottom") ?? "";
  const parts =
    /^max\((\d+)px, min\((\d+)px, calc\(100dvh - (\d+)px\)\)\)$/.exec(offset);
  if (!parts) throw new Error(`not a clamped offset: ${offset}`);
  const [floor = 0, limit = 0, taken = 0] = parts.slice(1).map(Number);
  return Math.max(floor, Math.min(limit, VIEWPORT - taken));
}

const spreadTop = (stack: number) => VIEWPORT - bottomEdge() - stack;

async function settled() {
  await act(() => vi.advanceTimersByTimeAsync(100));
}

test("the toaster keeps the stack that a hover spreads whole: above the clearance while it fits there, else as low as it takes to stay under the ceiling", async () => {
  vi.useFakeTimers();
  measureToasts({ Held: 98, Waiting: 250 });
  const { rerender } = render(<Toaster ceiling={36} />);
  act(() => {
    notify.choice(
      {
        icon: CircleCheck,
        message: "Waiting",
        choices: [{ label: "Move", run: () => undefined }],
      },
      "offer-1",
    );
  });
  await settled();
  expect(bottomEdge()).toBe(32);
  act(() => {
    notify.error("Held");
  });
  await settled();
  const stack = 98 + 6 + 250;

  rerender(<Toaster clearance={284} ceiling={36} />);
  expect(bottomEdge()).toBe(316);
  expect(spreadTop(stack)).toBe(90);
  rerender(<Toaster clearance={580} ceiling={36} />);
  expect(spreadTop(stack)).toBe(44);
  expect(bottomEdge()).toBe(362);
  rerender(<Toaster clearance={0} ceiling={36} />);
  expect(bottomEdge()).toBe(32);

  rerender(<Toaster clearance={580} ceiling={36} />);
  act(() => {
    toast.dismiss("offer-1");
  });
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(spreadTop(98)).toBe(50);
  expect(bottomEdge()).toBe(612);
  act(() => {
    toast.dismiss();
  });
  await act(() => vi.advanceTimersByTimeAsync(1000));
  vi.useRealTimers();
});

test("only the toasts that show are spread, three of them", async () => {
  vi.useFakeTimers();
  measureToasts({ Held: 98 });
  render(<Toaster clearance={580} ceiling={36} />);
  for (const n of [1, 2, 3, 4]) {
    act(() => {
      notify.error(`Held ${String(n)}`, { key: `held-${String(n)}` });
    });
    await settled();
  }
  expect(spreadTop(3 * 98 + 2 * 6)).toBe(44);
  act(() => {
    toast.dismiss();
  });
  await act(() => vi.advanceTimersByTimeAsync(1000));
  vi.useRealTimers();
});

test("a stack taller than the window under the title bar keeps the front toast above the status bar and lets its top go past the title bar", async () => {
  vi.useFakeTimers();
  measureToasts({ Held: 250 });
  render(<Toaster clearance={580} ceiling={36} />);
  for (const n of [1, 2, 3]) {
    act(() => {
      notify.error(`Held ${String(n)}`, { key: `held-${String(n)}` });
    });
    await settled();
  }
  const stack = 3 * 250 + 2 * 6;
  expect(bottomEdge()).toBe(32);
  expect(spreadTop(stack)).toBeLessThan(0);
  act(() => {
    toast.dismiss();
  });
  await act(() => vi.advanceTimersByTimeAsync(1000));
  vi.useRealTimers();
});

async function withUtilities() {
  const classes = new Set(
    Array.from(document.body.querySelectorAll("[class]")).flatMap((element) =>
      Array.from(element.classList),
    ),
  );
  const style = document.createElement("style");
  style.dataset.utilities = "";
  style.textContent = (await compile("@tailwind utilities;")).build([
    ...classes,
  ]);
  document.head.append(style);
}

async function stackOfTwo() {
  vi.useFakeTimers();
  render(<Toaster />);
  act(() => {
    notify.choice(
      {
        icon: CircleCheck,
        message: "Waiting",
        choices: [{ label: "Move", run: () => undefined }],
      },
      "offer-1",
    );
  });
  await settled();
  act(() => {
    notify.error("Held");
  });
  await settled();
  await withUtilities();
  const toastAt = (front: boolean) => {
    const found = document.querySelectorAll<HTMLElement>(
      `[data-sonner-toast][data-front="${String(front)}"]`,
    );
    if (found.length !== 1 || !found[0]) throw new Error("not one toast");
    return found[0];
  };
  const list = document.querySelector("[data-sonner-toaster]");
  if (!list) throw new Error("no toaster");
  return {
    toastAt,
    open: () => fireEvent.mouseEnter(list),
    close: () => fireEvent.mouseLeave(list),
    finish: async () => {
      act(() => {
        toast.dismiss();
      });
      await act(() => vi.advanceTimersByTimeAsync(1000));
      vi.useRealTimers();
    },
  };
}

function card(li: HTMLElement): HTMLElement {
  const found = li.querySelector("[data-title]")?.firstElementChild;
  if (!(found instanceof HTMLElement)) throw new Error("no card");
  return found;
}

function shows(element: Element): boolean {
  const li = element.closest("[data-sonner-toast]");
  for (
    let at: Element | null = element;
    at && at !== li;
    at = at.parentElement
  ) {
    if (Number.parseFloat(getComputedStyle(at).opacity) === 0) return false;
  }
  return getComputedStyle(element).visibility !== "hidden";
}

test("while the stack is closed a toast behind the front one is clipped to its box and keeps its card, with only the card's content hidden, and a hover shows it whole", async () => {
  const { toastAt, open, close, finish } = await stackOfTwo();
  const behind = toastAt(false);
  const content = Array.from(card(behind).children);
  expect(content.length).toBeGreaterThan(0);
  expect(getComputedStyle(behind).overflow).toBe("hidden");
  expect(shows(card(behind))).toBe(true);
  expect(content.map(shows)).toEqual(content.map(() => false));
  expect(getComputedStyle(toastAt(true)).overflow).not.toBe("hidden");
  expect(Array.from(card(toastAt(true)).children).every(shows)).toBe(true);

  open();
  expect(getComputedStyle(behind).overflow).not.toBe("hidden");
  expect(content.every(shows)).toBe(true);
  close();
  expect(shows(card(behind))).toBe(true);
  expect(content.map(shows)).toEqual(content.map(() => false));
  await finish();
});

test("while the stack is closed only the front toast's buttons can take focus, and a hover gives the others theirs", async () => {
  const { toastAt, open, close, finish } = await stackOfTwo();
  const focusable = (li: HTMLElement) =>
    Array.from(li.querySelectorAll("button")).filter(
      (button) => getComputedStyle(button).visibility !== "hidden",
    );
  expect(focusable(toastAt(false))).toEqual([]);
  expect(focusable(toastAt(true)).map((b) => b.ariaLabel)).toEqual(["Dismiss"]);

  open();
  expect(focusable(toastAt(false)).map((b) => b.textContent)).toEqual(["Move"]);
  close();
  expect(focusable(toastAt(false))).toEqual([]);
  await finish();
});

test("a toast past the three that show takes no focus, with the stack closed or open", async () => {
  vi.useFakeTimers();
  render(<Toaster />);
  act(() => {
    notify.choice(
      {
        icon: CircleCheck,
        message: "Oldest",
        choices: [{ label: "Move", run: () => undefined }],
      },
      "offer-1",
    );
  });
  await settled();
  for (const message of ["Second", "Third", "Front"]) {
    act(() => {
      notify.error(message);
    });
    await settled();
  }
  await withUtilities();
  const hidden = document.querySelector<HTMLElement>(
    '[data-sonner-toast][data-visible="false"]',
  );
  if (!hidden) throw new Error("no toast past the three");
  const move = Array.from(hidden.querySelectorAll("button")).find(
    (button) => button.textContent === "Move",
  );
  if (!move) throw new Error("no Move");
  const list = document.querySelector("[data-sonner-toaster]");
  if (!list) throw new Error("no toaster");
  expect(getComputedStyle(hidden).visibility).toBe("hidden");
  expect(getComputedStyle(move).visibility).toBe("hidden");
  fireEvent.mouseEnter(list);
  expect(getComputedStyle(hidden).visibility).toBe("hidden");
  expect(getComputedStyle(move).visibility).toBe("hidden");
  fireEvent.mouseLeave(list);
  act(() => {
    toast.dismiss();
  });
  await act(() => vi.advanceTimersByTimeAsync(1000));
  vi.useRealTimers();
});

test("a window of 600 px or less places the toasts as the wider ones", async () => {
  vi.useFakeTimers();
  measureToasts({ Held: 98 });
  render(<Toaster clearance={284} ceiling={36} />);
  act(() => {
    notify.error("Held");
  });
  await settled();
  const list = document.querySelector<HTMLElement>("[data-sonner-toaster]");
  const style = (name: string) => list?.style.getPropertyValue(name);
  expect(style("--offset-bottom")).not.toBe("");
  expect(style("--mobile-offset-bottom")).toBe(style("--offset-bottom"));
  expect(style("--mobile-offset-right")).toBe(style("--offset-right"));
  act(() => {
    toast.dismiss();
  });
  await act(() => vi.advanceTimersByTimeAsync(1000));
  vi.useRealTimers();
});

test("a window of 600 px or less keeps the list at the toaster's own width, at the right, and each toast at that width, as sonner's CSS for it would spread them across the window", async () => {
  vi.useFakeTimers();
  render(<Toaster />);
  act(() => {
    notify.error("Held");
  });
  await settled();
  const list = document.querySelector<HTMLElement>("[data-sonner-toaster]");
  const shown = document.querySelector<HTMLElement>("[data-sonner-toast]");
  expect(list?.style.getPropertyValue("--width")).toBe("288px");
  expect(list?.style.width).toBe("var(--width)");
  expect(list?.style.left).toBe("auto");
  expect(list?.style.getPropertyValue("--offset-right")).toBe("12px");
  expect(shown?.style.width).toBe("var(--width)");
  act(() => {
    toast.dismiss();
  });
  await act(() => vi.advanceTimersByTimeAsync(1000));
  vi.useRealTimers();
});

test("a choice's button takes a label as long as an absolute path inside the toast, wrapped, beside a column that cannot outgrow it", () => {
  const path =
    "/Users/someone/Library/Application Support/io.twigo.ide/proxy/process-0.kubeconfig";
  render(
    <ChoiceToast
      icon={CircleCheck}
      message="Terminal 1 added a context"
      choices={[
        { label: `Move to ${path}`, run: () => undefined },
        { label: "Dismiss", run: () => undefined },
      ]}
    />,
  );
  const move = screen.getByRole("button", { name: `Move to ${path}` });
  for (const kept of ["max-w-full", "whitespace-normal", "wrap-anywhere"]) {
    expect(move).toHaveClass(kept);
  }
  expect(move.parentElement?.parentElement).toHaveClass(
    "grid-cols-[minmax(0,1fr)]",
    "min-w-0",
  );
});
