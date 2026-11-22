import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMockBackend } from "@twigo/protocol/mock";
import { openList, withScreenSize } from "../../test/workbench";

withScreenSize();

beforeEach(() => {
  history.replaceState(null, "", "/?variant=wait:tooltip");
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
  vi.useRealTimers();
});

test("wait:tooltip keeps the word and the skeleton as they are, and puts the cause in the tooltip only", async () => {
  await openList(createMockBackend("connectRefused"));
  await act(() => vi.advanceTimersByTimeAsync(100));
  const word = within(screen.getByRole("contentinfo")).getByText("Connecting…");
  expect(word.closest("[title]")?.getAttribute("title")).toContain(
    "The cluster refused the connection",
  );
  expect(within(screen.getByRole("grid")).queryByRole("status")).toBeNull();
  expect(screen.queryByText(/connection refused/)).toBeNull();
});
