import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMockBackend } from "@twigo/protocol/mock";
import { openList, settle, withScreenSize } from "../../test/workbench";

withScreenSize();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test("wait:inline, the default: a list that cannot connect says why in the status bar and over its skeleton", async () => {
  await openList(createMockBackend("connectRefused"));
  await act(() => vi.advanceTimersByTimeAsync(100));
  const bar = within(screen.getByRole("contentinfo")).getByText(
    "Connecting · connection refused",
  );
  const line = within(screen.getByRole("grid")).getByText(
    "Connecting · connection refused",
  );
  expect(bar.closest("[title]")?.getAttribute("title")).toBe(
    [
      "Connecting · Kubernetes v1.33.4",
      "The cluster refused the connection: Connection refused (os error 61)",
      "connect.refused",
    ].join("\n"),
  );
  expect(line.closest("p")?.getAttribute("role")).toBe("status");
  expect(screen.getAllByRole("row").length).toBeLessThanOrEqual(1);
});

test("wait:inline: a list that lost its connection keeps its rows and says why beside the word", async () => {
  await openList(createMockBackend("connectLost"));
  await settle(4);
  expect(
    screen.getByText("No updates · reconnecting · connection lost"),
  ).toBeTruthy();
  expect(screen.getAllByRole("row").length).toBeGreaterThan(1);
});

test("wait:inline: a list that waits with no cause says only that it does", async () => {
  await openList(createMockBackend("connecting"));
  expect(
    within(screen.getByRole("contentinfo")).getByText("Connecting…"),
  ).toBeTruthy();
  expect(within(screen.getByRole("grid")).queryByRole("status")).toBeNull();
});
