import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
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

test("a tab's tooltip is what its editor says now, asked each time it opens, and none where the editor says none", async () => {
  const workbench = await testWorkbench();
  vi.useFakeTimers();
  try {
    let scope = "payments";
    workbench.editors.register({
      id: "test.note",
      scheme: "note",
      title: (uri) => uri.host,
      tooltip: (uri) => (uri.host === "a" ? `prod-eu › ${scope}` : undefined),
      component: ({ uri }) => <p>body of {uri}</p>,
    });
    render(<WorkbenchView workbench={workbench} />);
    act(() => {
      workbench.editors.open("note://a");
      workbench.editors.open("note://b");
    });
    const hover = async (uri: string) => {
      const tab = [...document.querySelectorAll(".dv-tab")]
        .find((each) => each.textContent === uri.slice("note://".length))
        ?.querySelector("[data-slot=tooltip-trigger]");
      if (!tab) throw new Error(`no tab for ${uri}`);
      fireEvent.pointerMove(tab, { pointerType: "mouse" });
      await act(() => vi.advanceTimersByTimeAsync(400));
      return tab;
    };
    const shown = () =>
      screen.queryAllByRole("tooltip").map((each) => each.textContent);

    const dismiss = async () => {
      for (const tab of document.querySelectorAll(
        "[data-slot=tooltip-trigger]",
      )) {
        fireEvent.pointerLeave(tab);
      }
      fireEvent.keyDown(document.body, { key: "Escape" });
      await act(() => vi.advanceTimersByTimeAsync(400));
    };

    await hover("note://a");
    expect(shown()).toEqual(["prod-eu › payments"]);
    await dismiss();
    expect(shown()).toEqual([]);

    scope = "checkout";
    await hover("note://a");
    expect(shown()).toEqual(["prod-eu › checkout"]);
    await dismiss();

    await hover("note://b");
    expect(shown()).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

test("a tab pressed does not open its tooltip, however long the press is held, and opens it again once the button is up", async () => {
  const workbench = await testWorkbench();
  vi.useFakeTimers();
  try {
    workbench.editors.register({
      id: "test.note",
      scheme: "note",
      title: (uri) => uri.host,
      tooltip: () => "prod-eu › payments",
      component: ({ uri }) => <p>body of {uri}</p>,
    });
    render(<WorkbenchView workbench={workbench} />);
    act(() => {
      workbench.editors.open("note://a");
    });
    const tab = document.querySelector(".dv-tab [data-slot=tooltip-trigger]");
    if (!tab) throw new Error("no tab");
    const shown = () => screen.queryAllByRole("tooltip").length;
    const wait = () => act(() => vi.advanceTimersByTimeAsync(400));

    fireEvent.pointerMove(tab, { pointerType: "mouse" });
    fireEvent.pointerDown(tab, { pointerType: "mouse" });
    await wait();
    expect(shown()).toBe(0);

    fireEvent.pointerCancel(tab, { pointerType: "mouse" });
    fireEvent.pointerLeave(tab, { pointerType: "mouse" });
    fireEvent.pointerMove(tab, { pointerType: "mouse" });
    await wait();
    expect(shown()).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});
