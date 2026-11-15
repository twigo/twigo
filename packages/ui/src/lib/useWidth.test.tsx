import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import { resize } from "../../test/resize";
import { useWidth } from "./useWidth";

test("an element that stops being laid out keeps the width it had", () => {
  const element = document.createElement("div");
  const measure = (width: number) => {
    Object.defineProperty(element, "clientWidth", {
      configurable: true,
      value: width,
    });
    act(() => {
      resize();
    });
  };
  const { result } = renderHook(() => useWidth(element));
  expect(result.current).toBe(0);
  measure(0);
  expect(result.current).toBe(0);
  measure(640.4);
  expect(result.current).toBe(640);
  measure(0);
  expect(result.current).toBe(640);
  measure(480);
  expect(result.current).toBe(480);
});
