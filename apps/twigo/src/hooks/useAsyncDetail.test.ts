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

  it("re-fetches when deps change", async () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: number }) => useAsyncDetail(() => Promise.resolve(id), [id]),
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
