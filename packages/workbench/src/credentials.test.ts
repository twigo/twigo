import { act } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MockScenario } from "@twigo/protocol/mock";
import { testWorkbench } from "./testing";

beforeEach(() => {
  // Real time moves them too, so the mock's answers come by themselves.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

async function started(scenario: MockScenario) {
  const workbench = await testWorkbench(scenario);
  await act(() => workbench.credentials.start());
  await vi.waitFor(() => {
    expect(workbench.credentials.auth.state).not.toBe("none");
  });
  return workbench;
}

test("an untrusted plugin asks when its space opens, and connects once trusted", async () => {
  const { credentials } = await started("untrusted");
  expect(credentials.context).toBe("prod-eu");
  expect(credentials.auth.state).toBe("untrusted");
  expect(credentials.trustOpen).toBe(true);
  const ready = credentials.ready;

  await credentials.trust();
  expect(credentials.trustOpen).toBe(false);
  expect(credentials.panelOpen).toBe(true);
  await vi.advanceTimersByTimeAsync(7000);
  expect(credentials.auth).toMatchObject({
    state: "plugin",
    status: { state: "ready" },
  });
  expect(credentials.panelOpen).toBe(false);
  expect(credentials.ready).toBe(ready + 1);
});

test("the first start's review asks instead of the prompt", async () => {
  const { credentials } = await started("review");
  expect(credentials.review.map((p) => p.contexts)).toEqual([
    ["prod-eu"],
    ["staging"],
    ["dev"],
    ["qa"],
  ]);
  expect(credentials.trustOpen).toBe(false);
  await credentials.answerReview([]);
  expect(credentials.review).toEqual([]);
  expect(credentials.trustOpen).toBe(false);
});

test("a sign-in that prints a code shows the panel at once, a silent one after a moment", async () => {
  const printing = await started("deviceCode");
  expect(printing.credentials.panelOpen).toBe(true);

  const silent = await started("browser");
  expect(silent.credentials.panelOpen).toBe(false);
  await vi.advanceTimersByTimeAsync(2100);
  expect(silent.credentials.panelOpen).toBe(true);
});

test("a cancelled sign-in stays on screen with its failure", async () => {
  const { credentials } = await started("deviceCode");
  await credentials.cancel();
  await vi.advanceTimersByTimeAsync(10);
  expect(credentials.auth).toMatchObject({
    state: "plugin",
    status: { state: "failed", error: "exec: kubelogin was cancelled" },
  });
  expect(credentials.panelOpen).toBe(true);
});
