import { act, cleanup, render, screen } from "@testing-library/react";
import type { SerializedDockview } from "dockview-react";
import { afterEach, expect, test, vi } from "vitest";
import { testWorkbench } from "../testing";
import { WorkbenchView } from "../WorkbenchView";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BROKEN = {
  grid: {
    root: {
      type: "branch",
      data: [
        {
          type: "leaf",
          data: { id: "1", views: ["note://a"], activeView: "note://a" },
          size: 100,
        },
      ],
      size: 100,
    },
    width: 100,
    height: 100,
    orientation: "HORIZONTAL",
  },
  panels: { "note://a": { id: "note://a", view: {} } },
} as unknown as SerializedDockview;

test("a saved layout that does not load is reported and leaves an empty area that works", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const workbench = await testWorkbench();
  const report = vi.spyOn(workbench, "report");
  workbench.editors.register({
    id: "test.note",
    scheme: "note",
    title: (uri) => uri.host,
    component: ({ uri }) => <p>body of {uri}</p>,
  });
  workbench.spaces.update("prod-eu", (state) => ({
    ...state,
    editors: BROKEN,
  }));
  render(<WorkbenchView workbench={workbench} />);
  expect(report).toHaveBeenCalledOnce();
  expect(document.querySelectorAll(".dv-tab")).toHaveLength(0);
  act(() => {
    workbench.editors.open("note://b");
  });
  expect(
    [...document.querySelectorAll(".dv-tab")].map((tab) => tab.textContent),
  ).toEqual(["b"]);
  expect(screen.getByText("body of note://b")).toBeTruthy();
});

test("an empty editor area shows the first watermark whose when holds, else its key hints", async () => {
  const workbench = await testWorkbench();
  workbench.editors.register({
    id: "test.note",
    scheme: "note",
    title: (uri) => uri.host,
    component: ({ uri }) => <p>body of {uri}</p>,
  });
  render(<WorkbenchView workbench={workbench} />);
  expect(screen.getByText("Go to resource")).toBeTruthy();
  act(() => {
    workbench.views.registerWatermark({
      id: "test.several",
      when: "space.multiContext",
      component: () => <p>several contexts</p>,
    });
    workbench.views.registerWatermark({
      id: "test.home",
      component: ({ space }) => <p>home of {space}</p>,
    });
    workbench.views.registerWatermark({
      id: "test.later",
      component: () => <p>registered later</p>,
    });
  });
  expect(screen.getByText("home of prod-eu")).toBeTruthy();
  expect(screen.queryByText("several contexts")).toBeNull();
  expect(screen.queryByText("registered later")).toBeNull();
  expect(screen.queryByText("Go to resource")).toBeNull();

  act(() => {
    workbench.editors.open("note://a");
  });
  expect(screen.queryByText("home of prod-eu")).toBeNull();
  act(() => {
    workbench.editors.close("note://a");
  });
  expect(screen.getByText("home of prod-eu")).toBeTruthy();
});
