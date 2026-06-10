import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useToasts } from "./toasts";

describe("toasts", () => {
  beforeEach(() => {
    useToasts.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pushes a toast and dismisses it by id", () => {
    useToasts.getState().push("error", "boom");
    const t = useToasts.getState().toasts;
    expect(t).toHaveLength(1);
    expect(t[0]?.kind).toBe("error");
    expect(t[0]?.message).toBe("boom");
    const id = t[0]?.id ?? -1;
    useToasts.getState().dismiss(id);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it("auto-dismisses after the TTL", () => {
    vi.useFakeTimers();
    useToasts.getState().push("info", "hi");
    expect(useToasts.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(6000);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });
});
