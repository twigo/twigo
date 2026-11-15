import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openList, settle, withScreenSize } from "./workbench";

withScreenSize();

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

const pods = async () => {
  await openList();
  expect(screen.getAllByRole("row").length).toBeGreaterThan(1);
};

test.fails(
  "a test that times out inside settle fails alone",
  () => settle(1_000_000),
  100,
);

test("the test after one that timed out inside settle reads its page", pods);

test.fails(
  "a test that times out inside its own act loop fails alone",
  async () => {
    for (;;) await act(() => vi.advanceTimersByTimeAsync(10));
  },
  100,
);

test(
  "the test after one that timed out inside its own act loop reads its page",
  pods,
);
