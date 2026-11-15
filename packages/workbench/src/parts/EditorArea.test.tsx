import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { SerializedDockview } from "dockview-react";
import { afterEach, expect, test, vi } from "vitest";
import { useActionRoom } from "../react";
import { testWorkbench } from "../testing";
import { WorkbenchView } from "../WorkbenchView";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
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

function Room() {
  return <p>room {String(useActionRoom())}</p>;
}

test("a group's actions get the strip's width less its tabs and the overflow button, as the tabs come and go and the strip resizes", async () => {
  const resizes = new Set<ResizeObserverCallback>();
  const unobserved = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(report: ResizeObserverCallback) {
      resizes.add(report);
    }
    observe() {
      return undefined;
    }
    unobserve() {
      return undefined;
    }
    disconnect() {
      return undefined;
    }
  };
  let strip = 900;
  const tabs: Record<string, number> = { "note://a": 120, "note://b": 220 };
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("dv-tabs-and-actions-container")
        ? strip
        : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return tabs[this.dataset.tabPanelId ?? ""] ?? 0;
    },
  });
  try {
    const workbench = await testWorkbench();
    workbench.editors.register({
      id: "test.note",
      scheme: "note",
      title: (uri) => uri.host,
      component: ({ uri }) => <p>body of {uri}</p>,
      actions: Room,
    });
    render(<WorkbenchView workbench={workbench} />);
    act(() => {
      workbench.editors.open("note://a", { preview: false });
    });
    await act(() => Promise.resolve());
    expect(screen.getByText("room 732")).toBeTruthy();

    act(() => {
      workbench.editors.open("note://b", { preview: false });
    });
    await act(() => Promise.resolve());
    expect(screen.getByText("room 512")).toBeTruthy();

    strip = 700;
    act(() => {
      const entry = {
        contentRect: new DOMRectReadOnly(0, 0, 700, 600),
        contentBoxSize: [{ inlineSize: 700, blockSize: 600 }],
      } as unknown as ResizeObserverEntry;
      for (const report of resizes) report([entry], {} as ResizeObserver);
    });
    expect(screen.getByText("room 312")).toBeTruthy();

    act(() => {
      workbench.editors.close("note://b");
    });
    await act(() => Promise.resolve());
    expect(screen.getByText("room 532")).toBeTruthy();
  } finally {
    globalThis.ResizeObserver = unobserved;
    Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
  }
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

const MOUSE = { pointerType: "mouse" };

async function tabWithTooltip() {
  const workbench = await testWorkbench();
  vi.useFakeTimers();
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
  return {
    tab,
    shown: () => screen.queryAllByRole("tooltip").length,
    wait: (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms)),
  };
}

test("a tab pressed does not open its tooltip, however long the press is held", async () => {
  const { tab, shown, wait } = await tabWithTooltip();
  fireEvent.pointerMove(tab, MOUSE);
  fireEvent.pointerDown(tab, MOUSE);
  await wait(400);
  expect(shown()).toBe(0);
  await wait(2000);
  expect(shown()).toBe(0);
});

test.each([
  ["the button going up", fireEvent.pointerUp],
  ["the press being cancelled", fireEvent.pointerCancel],
])("a press ended by %s lets the tooltip open at its delay", async (_, end) => {
  const { tab, shown, wait } = await tabWithTooltip();
  fireEvent.pointerMove(tab, MOUSE);
  fireEvent.pointerDown(tab, MOUSE);
  end(tab, MOUSE);
  await wait(400);
  expect(shown()).toBe(1);
});

test("a press held past the delay and left by the pointer lets the next hover open the tooltip", async () => {
  const { tab, shown, wait } = await tabWithTooltip();
  fireEvent.pointerMove(tab, MOUSE);
  fireEvent.pointerDown(tab, MOUSE);
  await wait(400);
  expect(shown()).toBe(0);
  fireEvent.pointerLeave(tab, MOUSE);
  fireEvent.pointerMove(tab, MOUSE);
  await wait(400);
  expect(shown()).toBe(1);
});

test("the delay is kept after a press held past it, so a hover straight after waits for it again", async () => {
  const { tab, shown, wait } = await tabWithTooltip();
  fireEvent.pointerMove(tab, MOUSE);
  fireEvent.pointerDown(tab, MOUSE);
  await wait(400);
  fireEvent.pointerUp(tab, MOUSE);
  fireEvent.pointerLeave(tab, MOUSE);
  fireEvent.pointerMove(tab, MOUSE);
  await wait(100);
  expect(shown()).toBe(0);
  await wait(300);
  expect(shown()).toBe(1);
});

test("the tooltip closes as the pointer leaves the tab, with no move after it", async () => {
  const { tab, shown, wait } = await tabWithTooltip();
  fireEvent.pointerMove(tab, MOUSE);
  await wait(400);
  expect(shown()).toBe(1);
  fireEvent.pointerLeave(tab, MOUSE);
  expect(shown()).toBe(0);
});
