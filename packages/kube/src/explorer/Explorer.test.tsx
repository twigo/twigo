import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMockBackend } from "@twigo/protocol/mock";
import {
  mountKube,
  openList,
  settle,
  withScreenSize,
} from "../../test/workbench";

withScreenSize();

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

const tree = () => screen.getByRole("tree", { name: "Resources" });
const item = (name: string | RegExp) =>
  within(tree()).getByRole("treeitem", { name });
const focused = () => {
  const id = tree().getAttribute("aria-activedescendant");
  return id === null ? undefined : document.getElementById(id)?.textContent;
};
const press = (code: string) => {
  fireEvent.keyDown(tree(), { code, key: code });
};

test("the list keys move through the tree, left and right close and open sections, Enter opens a kind", async () => {
  const workbench = await mountKube();
  tree().focus();
  expect(focused()).toBe("Workloads");

  press("ArrowDown");
  expect(focused()).toBe("Pods");
  press("Enter");
  expect(workbench.editors.active).toBe("k8s-list://prod-eu/v1/pods");

  press("ArrowLeft");
  expect(focused()).toBe("Workloads");
  press("ArrowLeft");
  expect(item("Workloads").getAttribute("aria-expanded")).toBe("false");
  press("KeyJ");
  expect(focused()).toBe("Config");
  press("ArrowRight");
  expect(item("Config").getAttribute("aria-expanded")).toBe("true");
  press("ArrowRight");
  expect(focused()).toBe("Config Maps");
  press("End");
  expect(focused()).toBe("Custom Resources");
});

test("open sections are kept per space, across switches and windows", async () => {
  const backend = createMockBackend("ready");
  const workbench = await mountKube(backend);
  fireEvent.click(item("Config"));
  expect(item("Config").getAttribute("aria-expanded")).toBe("true");

  act(() => {
    workbench.spaces.select("staging");
  });
  await settle();
  expect(item("Config").getAttribute("aria-expanded")).toBe("false");
  expect(item("Workloads").getAttribute("aria-expanded")).toBe("true");

  act(() => {
    workbench.spaces.select("prod-eu");
  });
  await settle();
  expect(item("Config").getAttribute("aria-expanded")).toBe("true");

  cleanup();
  await mountKube(backend);
  expect(item("Config").getAttribute("aria-expanded")).toBe("true");
});

const errorDot = (row: HTMLElement) => row.querySelector(".bg-error");
const healthButton = (name: string) =>
  within(screen.getByRole("group", { name: "Rows by health" })).getByRole(
    "button",
    { name: new RegExp(`^${name}`) },
  );

test("a kind whose list is open shows every row it has, and an error dot while some fail", async () => {
  const workbench = await mountKube();
  expect(item("Pods").textContent).toBe("Pods");
  act(() => {
    workbench.editors.open("k8s-list://prod-eu/v1/pods");
  });
  await settle();
  expect(item(/^Pods/).textContent).toBe("Pods5,000");
  expect(errorDot(item(/^Pods/))).not.toBeNull();

  fireEvent.click(healthButton("Failing"));
  await settle();
  expect(item(/^Pods/).textContent).toBe("Pods5,000");

  fireEvent.change(screen.getByRole("textbox", { name: "Filter rows" }), {
    target: { value: "Running" },
  });
  await settle();
  expect(item(/^Pods/).textContent).toMatch(/^Pods[\d,]+$/);
  expect(item(/^Pods/).textContent).not.toBe("Pods5,000");
  expect(errorDot(item(/^Pods/))).toBeNull();
});

test("a pinned list shows the rows its filters keep", async () => {
  const workbench = await openList(
    createMockBackend("ready"),
    "k8s-list://prod-eu/v1/pods?h=error",
  );
  fireEvent.click(screen.getByRole("button", { name: "Pin to the explorer" }));
  await settle(1);
  const failing = screen
    .getAllByRole("button", { name: /^[\d,]+ failing$/ })[0]
    ?.textContent.split(" ")[0];
  expect(failing).toMatch(/^[\d,]+$/);
  const pinned = item(/^PodsFailing/);
  expect(pinned.textContent).toBe(`PodsFailing${failing ?? ""}`);
  expect(workbench.editors.active).toBe("k8s-list://prod-eu/v1/pods?h=error");
});

test("a kind whose open list shows no rows counts nothing", async () => {
  await openList(createMockBackend("forbidden"));
  expect(screen.getByText("Access denied")).toBeTruthy();
  expect(item(/^Pods/).textContent).toBe("Pods");
});
