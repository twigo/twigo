import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useIsReadOnly } from "./useIsReadOnly";
import { useReadOnly } from "@/store/readonly";

describe("useIsReadOnly", () => {
  it("is true for a locked connection", () => {
    useReadOnly.setState({ byConn: { prod: true } });
    expect(renderHook(() => useIsReadOnly("prod")).result.current).toBe(true);
  });

  it("is false for an unlocked or absent connection", () => {
    useReadOnly.setState({ byConn: {} });
    expect(renderHook(() => useIsReadOnly("dev")).result.current).toBe(false);
    expect(renderHook(() => useIsReadOnly(null)).result.current).toBe(false);
  });
});
