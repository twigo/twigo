import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { FolderTree, Waypoints } from "lucide-react";
import { afterEach, expect, test } from "vitest";
import { inWorkbench, testWorkbench } from "../testing";
import { PartView } from "./PartView";

afterEach(cleanup);

test("with several containers the side bar shows them as tabs and remembers the pick", async () => {
  const workbench = await testWorkbench();
  act(() => {
    workbench.views.registerContainer({
      id: "a",
      title: "Explorer",
      icon: FolderTree,
      location: "sidebar",
    });
    workbench.views.registerContainer({
      id: "b",
      title: "Forwards",
      icon: Waypoints,
      location: "sidebar",
    });
    workbench.views.registerView({
      id: "va",
      title: "Tree",
      container: "a",
      component: () => <p>tree</p>,
    });
    workbench.views.registerView({
      id: "vb",
      title: "List",
      container: "b",
      component: () => <p>forwards</p>,
    });
  });
  render(<PartView location="sidebar" />, { wrapper: inWorkbench(workbench) });
  expect(screen.getByText("tree")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Forwards" }));
  expect(screen.getByText("forwards")).toBeTruthy();
  expect(workbench.spaces.state("prod-eu").parts.sidebar.container).toBe("b");
});

test("with one container the side bar shows its title", async () => {
  const workbench = await testWorkbench();
  act(() => {
    workbench.views.registerContainer({
      id: "a",
      title: "Explorer",
      icon: FolderTree,
      location: "sidebar",
    });
  });
  render(<PartView location="sidebar" />, { wrapper: inWorkbench(workbench) });
  expect(screen.queryByRole("tab")).toBeNull();
  expect(screen.getByRole("heading", { name: "Explorer" })).toBeTruthy();
});

test("a side bar sets --surface to its own tone, which a grid's overlay menu lies over", async () => {
  const workbench = await testWorkbench();
  act(() => {
    workbench.views.registerContainer({
      id: "a",
      title: "Explorer",
      icon: FolderTree,
      location: "sidebar",
    });
  });
  const { container } = render(<PartView location="sidebar" />, {
    wrapper: inWorkbench(workbench),
  });
  const bar = container.querySelector("section");
  expect(bar?.style.getPropertyValue("--surface")).toBe("var(--sidebar)");
  expect(bar?.classList.contains("bg-sidebar")).toBe(true);
});
