import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openList, settle, withScreenSize } from "../../test/workbench";

withScreenSize(1280);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

const OWN = "k8s-list://prod-eu/v1/pods?ns=payments&q=api";
const FOLLOWING = "k8s-list://prod-eu/v1/pods?q=api";
const SERVICES = "k8s-list://prod-eu/v1/services";

const groups = () =>
  [...document.querySelectorAll(".dv-groupview")]
    .map((group) =>
      [
        ...group.querySelectorAll<HTMLElement>("[role=tab][data-tab-panel-id]"),
      ].map(
        (tab) =>
          `${tab.dataset.tabPanelId ?? ""}${tab.querySelector("[data-preview=true]") ? " (preview)" : ""}`,
      ),
    )
    .filter((tabs) => tabs.length > 0);
const close = () =>
  screen.getByRole("button", { name: "Use the space's namespaces" });
const rows = () => screen.getAllByRole("row").slice(1);
const selected = () =>
  screen
    .queryAllByRole("row", { selected: true })
    .map((row) => row.querySelector('[data-column="Name"]')?.textContent);
const sorted = () =>
  screen
    .getAllByRole("columnheader")
    .filter((header) => header.getAttribute("aria-sort") !== null)
    .filter((header) => header.getAttribute("aria-sort") !== "none")
    .map(
      (header) => `${header.textContent}:${header.getAttribute("aria-sort")}`,
    );

test("the close mark of a list with namespaces of its own puts the following list in the same group and place, a preview as it was, and leaves the layout", async () => {
  const workbench = await openList(undefined, SERVICES);
  act(() => {
    workbench.editors.open(OWN, { side: true, preview: true });
    workbench.editors.open("k8s-list://prod-eu/apps/v1/deployments");
  });
  await settle();
  act(() => {
    workbench.editors.activate(OWN);
    workbench.editors.activate(SERVICES);
  });
  await settle(1);
  expect(groups()).toEqual([
    [SERVICES],
    [`${OWN} (preview)`, "k8s-list://prod-eu/apps/v1/deployments"],
  ]);

  fireEvent.click(close());
  await settle();
  expect(groups()).toEqual([
    [SERVICES],
    [`${FOLLOWING} (preview)`, "k8s-list://prod-eu/apps/v1/deployments"],
  ]);
});

test("the list that takes the place keeps the sort, the selected row and the open details of the one it replaced", async () => {
  await openList(undefined, OWN);
  fireEvent.click(
    within(screen.getByRole("columnheader", { name: "Ready" })).getByRole(
      "button",
    ),
  );
  await settle(1);
  const order = sorted();
  expect(order).toHaveLength(1);
  const [row] = rows();
  if (!row) throw new Error("no rows");
  fireEvent.click(row);
  await settle(1);
  const picked = selected();
  expect(picked).toHaveLength(1);
  expect(
    screen.getByRole("complementary", { name: "Pod details" }),
  ).toBeTruthy();

  fireEvent.click(close());
  await settle();
  expect(screen.queryByRole("button", { name: /^Namespaces?: / })).toBeNull();
  expect(sorted()).toEqual(order);
  expect(selected()).toEqual(picked);
  expect(
    screen.getByRole("complementary", { name: "Pod details" }),
  ).toBeTruthy();
});

test("a selected row that the space's scope does not read is not carried", async () => {
  const workbench = await openList(undefined, OWN);
  act(() => {
    workbench.spaces.update("prod-eu", (state) => ({
      ...state,
      namespaces: ["auth"],
    }));
  });
  await settle();
  const [row] = rows();
  if (!row) throw new Error("no rows");
  fireEvent.click(row);
  await settle(1);
  expect(selected()).toHaveLength(1);

  fireEvent.click(close());
  await settle();
  expect(selected()).toEqual([]);
  expect(
    screen.queryByRole("complementary", { name: "Pod details" }),
  ).toBeNull();
});

test("the close mark of a list that follows the space gives the focus to the list's grid, not to the page", async () => {
  const workbench = await openList(undefined, "k8s-list://prod-eu/v1/pods");
  act(() => {
    workbench.spaces.update("prod-eu", (state) => ({
      ...state,
      namespaces: ["payments"],
    }));
  });
  await settle();
  const mark = screen.getByRole("button", { name: "Show all namespaces" });
  act(() => {
    mark.focus();
  });
  fireEvent.click(mark);
  await settle();
  expect(screen.queryByRole("button", { name: /^Namespaces?: / })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("grid"));
});
