import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Histogram } from "./histogram";

afterEach(cleanup);

const BUCKETS = Array.from({ length: 4 }, () => ({
  total: 10,
  warnings: 2,
  errors: 1,
}));

function histogram() {
  const onSelect = vi.fn();
  render(
    <Histogram
      label="Lines over time"
      buckets={BUCKETS}
      ticks={["10:00", "now"]}
      onSelect={onSelect}
    />,
  );
  const bars = screen.getByRole("img", { name: "Lines over time" });
  bars.getBoundingClientRect = () =>
    ({ left: 0, width: 400, top: 0, height: 26 }) as DOMRect;
  bars.setPointerCapture = () => undefined;
  return { bars, onSelect };
}

test("a click picks its bucket's span, a drag the span it covers", () => {
  const { bars, onSelect } = histogram();
  fireEvent.pointerDown(bars, { clientX: 150, pointerId: 1 });
  fireEvent.pointerUp(bars, { clientX: 150, pointerId: 1 });
  expect(onSelect).toHaveBeenLastCalledWith({ from: 0.25, to: 0.5 });
  fireEvent.pointerDown(bars, { clientX: 300, pointerId: 1 });
  fireEvent.pointerMove(bars, { clientX: 100, pointerId: 1 });
  fireEvent.pointerUp(bars, { clientX: 100, pointerId: 1 });
  expect(onSelect).toHaveBeenLastCalledWith({ from: 0.25, to: 0.75 });
});
