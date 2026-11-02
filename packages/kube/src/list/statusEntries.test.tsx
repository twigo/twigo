import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMockBackend } from "@twigo/protocol/mock";
import { StateStore, Workbench, WorkbenchView } from "@twigo/workbench";
import { registerKube } from "./register";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test("the cluster's version comes once its credential does", async () => {
  const backend = createMockBackend("untrusted");
  const workbench = new Workbench(
    backend,
    "mac",
    { id: "us", keys: {} },
    await StateStore.load(backend, () => undefined),
  );
  registerKube(workbench);
  await act(() =>
    Promise.all([workbench.catalog.watch(), workbench.spaces.load()]),
  );
  await act(() => workbench.credentials.start());
  render(<WorkbenchView workbench={workbench} />);
  await act(() => vi.advanceTimersByTimeAsync(100));
  expect(screen.queryByText("v1.33.4")).toBeNull();

  const { auth } = workbench.credentials;
  if (auth.state !== "untrusted") throw new Error(auth.state);
  await act(() => workbench.credentials.trust(auth.plugin.digest));
  await act(() => vi.advanceTimersByTimeAsync(7000));
  expect(await screen.findByText("v1.33.4")).toBeTruthy();
});
