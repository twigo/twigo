import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { EmbeddedList as Spec, ObjectRef } from "@twigo/protocol";
import { inWorkbench, testWorkbench } from "@twigo/workbench/testing";
import { settle, withScreenSize } from "../../test/workbench";
import { EmbeddedList } from "./EmbeddedList";
import { OverviewStates } from "./overviewStates";

withScreenSize();

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NODE_PODS: Spec = {
  gvr: { group: "", version: "v1", resource: "pods" },
  kind: "Pod",
  namespaced: true,
  namespace: null,
  fieldSelector: "spec.nodeName=prod-eu-node-0",
  owners: null,
};

async function shown(
  list: Spec,
  onOpen: (target: ObjectRef) => void,
  states = new OverviewStates(),
) {
  const pending = testWorkbench("ready");
  await vi.advanceTimersByTimeAsync(10);
  const workbench = await pending;
  render(
    <EmbeddedList
      list={list}
      space="prod-eu"
      states={states}
      kind="/nodes"
      id="core.pods"
      onOpen={onOpen}
    />,
    {
      wrapper: inWorkbench(workbench),
    },
  );
  await settle();
  return workbench;
}

function rows(): HTMLElement[] {
  return within(screen.getByRole("grid")).getAllByRole("row").slice(1);
}

test("a node's pods come counted by status, and a row opens its pod", async () => {
  const onOpen = vi.fn();
  await shown(NODE_PODS, onOpen);
  const first = rows()[0];
  expect(first).toBeDefined();
  expect(document.body.textContent).toMatch(/\d+ Running/);
  act(() => {
    first?.click();
  });
  const name = first?.textContent ?? "";
  expect(onOpen).toHaveBeenCalledOnce();
  const target = onOpen.mock.calls[0]?.[0] as ObjectRef;
  expect(target).toMatchObject({ group: "", version: "v1", kind: "Pod" });
  expect(target.namespace).not.toBeNull();
  expect(name).toContain(target.name);
});

test("the keys of lists move along its rows and open one", async () => {
  const onOpen = vi.fn();
  const workbench = await shown(NODE_PODS, onOpen);
  const grid = screen.getByRole("grid");
  act(() => {
    grid.focus();
  });
  const lookup = workbench.keys.lookup(grid);
  await act(async () => {
    await workbench.commands.execute("list.focusDown", lookup);
  });
  await act(async () => {
    await workbench.commands.execute("list.select", lookup);
  });
  expect(onOpen).toHaveBeenCalledOnce();
});

test("owners that control nothing list no pods", async () => {
  await shown({ ...NODE_PODS, fieldSelector: null, owners: [] }, vi.fn());
  expect(screen.getByText("No pods")).toBeDefined();
  expect(screen.queryByRole("grid")).toBeNull();
});

test("a sort is kept for the kind's next object", async () => {
  const states = new OverviewStates();
  await shown(NODE_PODS, vi.fn(), states);
  act(() => {
    within(screen.getByRole("columnheader", { name: "Name" }))
      .getByRole("button")
      .click();
  });
  expect(states.sort("/nodes", "core.pods")).toMatchObject({ column: "Name" });
});
