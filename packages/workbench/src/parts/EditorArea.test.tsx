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
