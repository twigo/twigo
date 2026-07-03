import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { reportUnexpectedError } from "./errors";
import { useToasts } from "@/store/toasts";

describe("reportUnexpectedError", () => {
  beforeEach(() => {
    useToasts.setState({ toasts: [] });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("surfaces the error as a toast", () => {
    reportUnexpectedError("test", new Error("boom"));
    const [toast] = useToasts.getState().toasts;
    expect(toast?.kind).toBe("error");
    expect(toast?.message).toBe("Unexpected error: boom");
  });

  it("coalesces repeats of the same message instead of stacking", () => {
    reportUnexpectedError("a", new Error("boom"));
    reportUnexpectedError("b", new Error("boom"));
    const { toasts } = useToasts.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.count).toBe(2);
  });

  it("stringifies non-Error rejection reasons", () => {
    reportUnexpectedError("test", "plain failure");
    expect(useToasts.getState().toasts[0]?.message).toBe(
      "Unexpected error: plain failure",
    );
  });
});
