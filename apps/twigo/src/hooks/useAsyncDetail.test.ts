import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useAsyncDetail } from "./useAsyncDetail";

describe("useAsyncDetail", () => {
  it("loads, exposes data, and clears loading", async () => {
    const { result } = renderHook(() =>
      useAsyncDetail(() => Promise.resolve(42), []),
    );
    expect(result.current.loading).toBe(true);
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.data).toBe(42);
    expect(result.current.error).toBeNull();
  });

  it("captures the error message and leaves data null", async () => {
    const { result } = renderHook(() =>
      useAsyncDetail(() => Promise.reject(new Error("nope")), []),
    );
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBe("nope");
    expect(result.current.data).toBeNull();
  });

  it("re-fetches on refresh()", async () => {
    let n = 0;
    const fetcher = vi.fn(() => Promise.resolve((n += 1)));
    const { result } = renderHook(() => useAsyncDetail(fetcher, []));
    await waitFor(() => {
      expect(result.current.data).toBe(1);
    });
    act(() => {
      result.current.refresh();
    });
    await waitFor(() => {
      expect(result.current.data).toBe(2);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refreshes in the background without flipping loading", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const fetcher = vi.fn(() => Promise.resolve((n += 1)));
      const { result } = renderHook(() => useAsyncDetail(fetcher, [], 1000));
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.data).toBe(1);

      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
      expect(result.current.data).toBe(2);
      expect(result.current.loading).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the last good data when a background poll fails, and says why", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi
        .fn<() => Promise<string>>()
        .mockResolvedValueOnce("ok")
        .mockRejectedValueOnce(new Error("server went away"))
        .mockResolvedValue("back");
      const { result } = renderHook(() => useAsyncDetail(fetcher, [], 1000));
      await act(async () => {
        await Promise.resolve();
      });

      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
      expect(result.current.data).toBe("ok");
      expect(result.current.error).toBeNull();
      expect(result.current.staleReason).toBe("server went away");

      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
      expect(result.current.data).toBe("back");
      expect(result.current.staleReason).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not poll when no interval is given", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(() => Promise.resolve(1));
      renderHook(() => useAsyncDetail(fetcher, []));
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(60_000);
        await Promise.resolve();
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-fetches when deps change", async () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: number }) =>
        useAsyncDetail(() => Promise.resolve(id), [id]),
      { initialProps: { id: 1 } },
    );
    await waitFor(() => {
      expect(result.current.data).toBe(1);
    });
    rerender({ id: 2 });
    await waitFor(() => {
      expect(result.current.data).toBe(2);
    });
  });
});
