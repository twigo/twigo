import { act } from "@testing-library/react";
import { FolderTree, Waypoints } from "lucide-react";
import { expect, test, vi } from "vitest";
import { testWorkbench } from "./testing";
import type { Workbench } from "./services";

const enabled = (workbench: Workbench, command: string) =>
  workbench.commands.enabled(command, workbench.keys.lookup(null));

test("selectSpaceN selects the Nth space and is enabled while there is one", async () => {
  const workbench = await testWorkbench();
  expect(enabled(workbench, "workbench.action.selectSpace4")).toBe(true);
  expect(enabled(workbench, "workbench.action.selectSpace5")).toBe(false);

  await act(() =>
    workbench.commands.execute(
      "workbench.action.selectSpace2",
      workbench.keys.lookup(null),
    ),
  );
  expect(workbench.spaces.active?.id).toBe("staging");

  await act(() => workbench.spaces.open("kind-local"));
  expect(enabled(workbench, "workbench.action.selectSpace5")).toBe(true);
  expect(enabled(workbench, "workbench.action.selectSpace6")).toBe(false);
});

test("moveView moves one view, then another", async () => {
  const workbench = await testWorkbench();
  const { views, quickAccess } = workbench;
  views.registerContainer({
    id: "explorer",
    title: "Explorer",
    icon: FolderTree,
    location: "sidebar",
  });
  views.registerContainer({
    id: "forwards",
    title: "Forwards",
    icon: Waypoints,
    location: "panel",
  });
  for (const id of ["tree", "list"]) {
    views.registerView({
      id,
      title: id,
      container: "explorer",
      component: () => null,
    });
  }
  const choose = async (id: string) => {
    const item = await vi.waitFor(() => {
      const found = quickAccess.session?.pick?.items.find(
        (candidate) => candidate.id === id,
      );
      if (!found) throw new Error(`no pick offers ${id}`);
      return found;
    });
    await act(() => quickAccess.accept(item));
  };

  for (const view of ["tree", "list"]) {
    const done = workbench.commands.execute(
      "workbench.action.moveView",
      workbench.keys.lookup(null),
    );
    await choose(view);
    await choose("forwards");
    await act(() => done);
  }
  expect(workbench.spaces.state("prod-eu").placement).toEqual({
    tree: "forwards",
    list: "forwards",
  });
  expect(quickAccess.session).toBeUndefined();
});
