import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useToasts } from "./toasts";

describe("toasts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToasts.setState({ toasts: [], queue: [] });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("pushes a toast and removes it by id after the exit animation", () => {
    useToasts.getState().push("error", "boom");
    const t = useToasts.getState().toasts;
    expect(t).toHaveLength(1);
    expect(t[0]?.kind).toBe("error");
    expect(t[0]?.count).toBe(1);
    const id = t[0]?.id ?? -1;

    useToasts.getState().dismiss(id);
    // Two-phase: still present but leaving, then gone after EXIT_MS.
    expect(useToasts.getState().toasts[0]?.leaving).toBe(true);
    vi.advanceTimersByTime(150);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it("auto-dismisses info after its TTL but keeps errors sticky", () => {
    useToasts.getState().push("info", "hi");
    useToasts.getState().push("error", "stay");
    vi.advanceTimersByTime(6000 + 150);
    const t = useToasts.getState().toasts;
    expect(t).toHaveLength(1);
    expect(t[0]?.kind).toBe("error");
    // The error never schedules a timer.
    vi.advanceTimersByTime(60_000);
    expect(useToasts.getState().toasts).toHaveLength(1);
  });

  it("coalesces identical repeats into one toast with a count and resets the timer", () => {
    useToasts.getState().push("warning", "slow", { key: "k" });
    vi.advanceTimersByTime(3000);
    useToasts.getState().push("warning", "slow", { key: "k" });
    const t = useToasts.getState().toasts;
    expect(t).toHaveLength(1);
    expect(t[0]?.count).toBe(2);
  });

  it("replaces in place without bumping the count on a lifecycle change", () => {
    useToasts.getState().push("warning", "Lost connection - reconnecting…", {
      key: "conn:x:link",
    });
    useToasts.getState().push("success", "Reconnected", { key: "conn:x:link" });
    const t = useToasts.getState().toasts;
    expect(t).toHaveLength(1);
    expect(t[0]?.kind).toBe("success");
    expect(t[0]?.message).toBe("Reconnected");
    expect(t[0]?.count).toBe(1);
  });

  it("keeps an actionable success longer and runs its action", () => {
    const run = vi.fn();
    useToasts
      .getState()
      .push("success", "Saved x", { action: { label: "Undo", run } });
    const t = useToasts.getState().toasts[0];
    expect(t?.action?.label).toBe("Undo");
    t?.action?.run();
    expect(run).toHaveBeenCalledOnce();
    // Past the normal success TTL, still alive on the actionable floor.
    vi.advanceTimersByTime(6000);
    expect(useToasts.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(4000 + 150);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it("keeps the action and actionable lifetime when a repeat omits the action", () => {
    const run = vi.fn();
    useToasts
      .getState()
      .push("success", "Saved x", { key: "k", action: { label: "Undo", run } });
    useToasts.getState().push("success", "Saved x", { key: "k" });
    const t = useToasts.getState().toasts[0];
    expect(t?.count).toBe(2);
    expect(t?.action?.label).toBe("Undo");
    // Still on the 10s actionable floor, not the 4s success default.
    vi.advanceTimersByTime(6000);
    expect(useToasts.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(4000 + 150);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it("caps visible toasts at 3 and promotes from the queue on dismiss", () => {
    for (const m of ["a", "b", "c", "d"]) {
      useToasts.getState().push("info", m);
    }
    expect(useToasts.getState().toasts).toHaveLength(3);
    expect(useToasts.getState().queue).toHaveLength(1);
    expect(useToasts.getState().queue[0]?.message).toBe("d");

    const first = useToasts.getState().toasts[0]?.id ?? -1;
    useToasts.getState().dismiss(first);
    vi.advanceTimersByTime(150);
    const t = useToasts.getState().toasts;
    expect(t).toHaveLength(3);
    expect(t.some((x) => x.message === "d")).toBe(true);
    expect(useToasts.getState().queue).toHaveLength(0);
  });
});
