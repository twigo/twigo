import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMockBackend } from "@twigo/protocol/mock";
import { StateStore, Workbench, WorkbenchView } from "@twigo/workbench";
import { registerKube } from "./register";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(() => vi.advanceTimersByTimeAsync(50));
  }
}

async function mounted(backend = createMockBackend("ready")) {
  const state = StateStore.load(backend, () => undefined);
  await act(() => vi.advanceTimersByTimeAsync(10));
  const workbench = new Workbench(
    backend,
    "mac",
    { id: "us", keys: {} },
    await state,
  );
  registerKube(workbench);
  const loaded = Promise.all([
    workbench.catalog.watch(),
    workbench.spaces.load(),
  ]);
  await act(() => vi.advanceTimersByTimeAsync(10));
  await loaded;
  render(<WorkbenchView workbench={workbench} />);
  await settle();
  return workbench;
}

const tree = () => screen.getByRole("tree", { name: "Resources" });
const item = (name: string) => within(tree()).getByRole("treeitem", { name });
const focused = () => {
  const id = tree().getAttribute("aria-activedescendant");
  return id === null ? undefined : document.getElementById(id)?.textContent;
};
const press = (code: string) => {
  fireEvent.keyDown(tree(), { code, key: code });
};

test("the list keys move through the tree, left and right close and open sections, Enter opens a kind", async () => {
  const workbench = await mounted();
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
  const workbench = await mounted(backend);
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
  await mounted(backend);
  expect(item("Config").getAttribute("aria-expanded")).toBe("true");
});
