import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMockBackend } from "@twigo/protocol/mock";
import { openList, settle, withScreenSize } from "../../test/workbench";
import { DWELL_MS } from "../Details";

withScreenSize(1400);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

test("keys in a Deployment's pods list inside its details act on that list alone", async () => {
  const workbench = await openList(
    createMockBackend("ready"),
    "k8s-list://prod-eu/apps/v1/deployments",
  );
  const main = screen.getAllByRole("grid")[0];
  const first = main && within(main).getAllByRole("row")[1];
  if (!first) throw new Error("a deployment");
  fireEvent.click(first);
  await act(() => vi.advanceTimersByTimeAsync(DWELL_MS + 50));
  await settle(10);
  const drawer = screen.getByRole("complementary", {
    name: "Deployment details",
  });
  const selectedTab = () =>
    within(drawer)
      .getAllByRole("tab")
      .find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent;
  expect(selectedTab()).toBe("Overview");
  const pods = within(drawer).getByRole("grid");
  act(() => {
    pods.focus();
  });
  fireEvent.keyDown(pods, { code: "KeyJ", key: "j" });
  await settle(2);
  fireEvent.keyDown(pods, { code: "KeyE", key: "e" });
  await settle(2);
  expect(selectedTab()).toBe("Overview");
  fireEvent.keyDown(pods, { code: "Space", key: " " });
  await settle(4);
  expect(
    screen.getByRole("complementary", { name: "Deployment details" }),
  ).toBeDefined();
  fireEvent.keyDown(pods, { code: "Slash", key: "/" });
  await settle(2);
  expect(document.activeElement).toBe(pods);
  expect(workbench.keys.lookup(pods)("resource.selected")).toBe(false);
  expect(workbench.keys.lookup(pods)("listMarked")).toBe(false);
  fireEvent.keyDown(pods, { code: "Escape", key: "Escape" });
  await settle(4);
  expect(
    screen.queryByRole("complementary", { name: "Deployment details" }),
  ).toBeNull();
});
