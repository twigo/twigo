import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { inWorkbench, testWorkbench } from "../testing";
import { UNLOCK_CONTEXT } from "../spaces/modeCommands";
import { UnlockBanner } from "./UnlockBanner";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function mounted() {
  const workbench = await testWorkbench();
  render(<UnlockBanner />, { wrapper: inWorkbench(workbench) });
  await act(() => Promise.resolve());
  return workbench;
}

test("it shows only while the context is unlocked, counts down and relocks by itself", async () => {
  const { commands, keys, catalog } = await mounted();
  expect(screen.queryByText(/is unlocked/)).toBeNull();

  await act(() => commands.execute(UNLOCK_CONTEXT, keys.lookup(null)));
  expect(screen.getByText("prod-eu is unlocked.")).toBeTruthy();
  expect(screen.getByText("15:00")).toBeTruthy();

  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(screen.getByText("14:00")).toBeTruthy();

  await act(() => vi.advanceTimersByTimeAsync(14 * 60_000 + 10));
  expect(screen.queryByText(/is unlocked/)).toBeNull();
  expect(catalog.find("prod-eu")?.access.mode).toBe("read-only");
});

test("it belongs to the active space, and a new unlock starts its count again", async () => {
  const { backend, commands, keys, spaces } = await mounted();
  await act(() => commands.execute(UNLOCK_CONTEXT, keys.lookup(null)));
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(screen.getByText("14:00")).toBeTruthy();

  act(() => {
    spaces.select("dev");
  });
  expect(screen.queryByText(/is unlocked/)).toBeNull();
  act(() => {
    spaces.select("prod-eu");
  });
  expect(screen.getByText("14:00")).toBeTruthy();

  await act(() => backend.invoke("context_unlock", "prod-eu"));
  expect(screen.getByText("15:00")).toBeTruthy();
});

test("Lock now ends it", async () => {
  const { commands, keys, catalog } = await mounted();
  await act(() => commands.execute(UNLOCK_CONTEXT, keys.lookup(null)));
  fireEvent.click(screen.getByRole("button", { name: "Lock now" }));
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(screen.queryByText(/is unlocked/)).toBeNull();
  expect(catalog.find("prod-eu")?.access.mode).toBe("read-only");
});
