import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { SerializedDockview } from "dockview-react";
import { afterEach, expect, test, vi } from "vitest";
import { Changes } from "../changes";
import type { SessionState } from "../editors/registry";
import { useActionRoom } from "../react";
import { testWorkbench } from "../testing";
import { WorkbenchView } from "../WorkbenchView";
import { STRIP_KEPT, TAB_MAX, TITLE_FLOOR } from "./strip";

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

test("a tab whose title ends in what tells tabs apart cuts it in the middle past the floor and keeps the last part of its name, any other title is left whole for the end to cut", async () => {
  const workbench = await testWorkbench();
  workbench.editors.register({
    id: "test.note",
    scheme: "note",
    title: (uri) => uri.host,
    titleEndTells: true,
    component: ({ uri }) => <p>body of {uri}</p>,
  });
  workbench.editors.register({
    id: "test.list",
    scheme: "list",
    title: (uri) => uri.host,
    component: ({ uri }) => <p>body of {uri}</p>,
  });
  render(<WorkbenchView workbench={workbench} />);
  act(() => {
    workbench.editors.open("note://auth-api-1tvckat-tszk7", {
      preview: false,
    });
    workbench.editors.open("list://validating-webhook-configurations", {
      preview: false,
    });
    workbench.editors.open("note://pods", { preview: false });
  });
  const title = (text: string) => {
    const found = [...document.querySelectorAll(".dv-tab [data-preview]")].find(
      (each) => each.textContent === text,
    );
    if (!found) throw new Error(`no tab titled ${text}`);
    return found;
  };
  const parts = (text: string) =>
    [...(title(text).firstElementChild?.children ?? [])].map(
      (part) => part.textContent,
    );

  const cut = parts("auth-api-1tvckat-tszk7");
  expect(cut).toEqual(["auth-api-1t", "vckat-", "tszk7"]);
  expect((cut[0] ?? "").length + (cut[2] ?? "").length).toBe(TITLE_FLOOR);
  expect(parts("pods")).toEqual([]);
  expect(title("validating-webhook-configurations").children).toHaveLength(0);
});

test("a session's tab says how the session stands: nothing while it runs, a pulse while it connects, ended after its title, an error dot once it failed, and it follows the session", async () => {
  const workbench = await testWorkbench();
  const states = new Map<string, SessionState>([
    ["run", "running"],
    ["connect", "connecting"],
    ["end", "ended"],
    ["fail", "failed"],
  ]);
  const changes = new Changes();
  workbench.editors.register({
    id: "test.job",
    scheme: "job",
    title: (uri) => uri.host,
    component: ({ uri }) => <p>body of {uri}</p>,
    session: { changes, state: (uri) => states.get(new URL(uri).host) },
  });
  render(<WorkbenchView workbench={workbench} />);
  act(() => {
    for (const host of states.keys()) {
      workbench.editors.open(`job://${host}`, { preview: false });
    }
  });
  const tab = (host: string) => {
    const found = [...document.querySelectorAll(".dv-tab")].find((each) =>
      each.getAttribute("data-tab-panel-id")?.endsWith(host),
    );
    if (!found) throw new Error(`no tab of ${host}`);
    return found;
  };
  const dot = (host: string) => tab(host).querySelector("[role=img]");
  const stated = (host: string) =>
    tab(host).querySelector<HTMLElement>("[data-session]")?.dataset.session;

  expect(stated("run")).toBe("running");
  expect(tab("run").textContent).toBe("run");
  expect(dot("run")).toBeNull();

  expect(dot("connect")?.getAttribute("aria-label")).toBe("Connecting");
  expect(dot("connect")?.className).toContain("animate-pulse");

  expect(tab("end").textContent).toBe("endended");
  expect(dot("end")).toBeNull();
  expect(stated("end")).toBe("ended");

  expect(dot("fail")?.getAttribute("aria-label")).toBe("Failed");
  expect(dot("fail")?.className).toContain("bg-error");
  expect(dot("fail")?.className).not.toContain("animate-pulse");
  expect(tab("fail").textContent).toBe("fail");

  const after = (host: string) =>
    tab(host).querySelector("[data-preview]")?.nextElementSibling;
  expect(after("end")?.textContent).toBe("ended");
  expect(after("connect")).toBe(dot("connect"));
  expect(after("fail")).toBe(dot("fail"));
  expect(after("run")?.tagName).toBe("BUTTON");

  states.set("connect", "running");
  states.set("run", "ended");
  act(() => {
    changes.emit();
  });
  expect(dot("connect")).toBeNull();
  expect(tab("run").textContent).toBe("runended");
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

function fakeResizes() {
  const observers = new Map<ResizeObserverCallback, Set<Element>>();
  const unobserved = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    readonly #targets = new Set<Element>();
    constructor(report: ResizeObserverCallback) {
      observers.set(report, this.#targets);
    }
    observe(target: Element) {
      this.#targets.add(target);
    }
    unobserve(target: Element) {
      this.#targets.delete(target);
    }
    disconnect() {
      this.#targets.clear();
    }
  };
  return {
    report(width: number) {
      act(() => {
        for (const [report, targets] of observers) {
          const entries = [...targets].map(
            (target) =>
              ({
                target,
                contentRect: new DOMRectReadOnly(0, 0, width, 600),
              }) as unknown as ResizeObserverEntry,
          );
          if (entries.length > 0) report(entries, {} as ResizeObserver);
        }
      });
    },
    restore() {
      globalThis.ResizeObserver = unobserved;
    },
  };
}

test("a group's actions get the strip's width less its tabs, the space before and between them, the overflow button and the space after them, as the tabs come and go and the strip resizes", async () => {
  const resizes = fakeResizes();
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
    expect(screen.getByText("room 742")).toBeTruthy();

    act(() => {
      workbench.editors.open("note://b", { preview: false });
    });
    await act(() => Promise.resolve());
    expect(screen.getByText("room 520")).toBeTruthy();

    strip = 700;
    resizes.report(700);
    expect(screen.getByText("room 320")).toBeTruthy();

    act(() => {
      workbench.editors.close("note://b");
    });
    await act(() => Promise.resolve());
    expect(screen.getByText("room 542")).toBeTruthy();
  } finally {
    resizes.restore();
    Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
  }
});

test("a strip as wide as what it keeps besides its actions, and a stage of theirs, leaves them that stage beside an active tab at its widest", async () => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("dv-tabs-and-actions-container")
        ? STRIP_KEPT + 300
        : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.tabPanelId === undefined ? 0 : TAB_MAX;
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
    expect(screen.getByText("room 300")).toBeTruthy();
  } finally {
    Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
  }
});

function OwnState({ uri }: { uri: string }) {
  const [first] = useState(uri);
  return <p>actions of {first}</p>;
}

test("a group's actions belong to the editor they are for: another editor of the group gets them anew", async () => {
  const workbench = await testWorkbench();
  workbench.editors.register({
    id: "test.note",
    scheme: "note",
    title: (uri) => uri.host,
    component: ({ uri }) => <p>body of {uri}</p>,
    actions: OwnState,
  });
  render(<WorkbenchView workbench={workbench} />);
  act(() => {
    workbench.editors.open("note://a", { preview: false });
  });
  await act(() => Promise.resolve());
  expect(screen.getByText("actions of note://a")).toBeTruthy();
  act(() => {
    workbench.editors.open("note://b", { preview: false });
  });
  await act(() => Promise.resolve());
  expect(screen.getByText("actions of note://b")).toBeTruthy();
  expect(screen.queryByText("actions of note://a")).toBeNull();
});

test("each measure brings the active tab back into view by the tab list's own scroll, and scrolls nothing else", async () => {
  const resizes = fakeResizes();
  const into = vi.spyOn(Element.prototype, "scrollIntoView");
  const left: Record<string, number> = { "note://a": 0, "note://b": 400 };
  Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
    configurable: true,
    get(this: HTMLElement) {
      return left[this.dataset.tabPanelId ?? ""] ?? 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.tabPanelId === undefined ? 0 : 220;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("dv-tabs-container") ? 300 : 0;
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
      workbench.editors.open("note://b", { preview: false });
    });
    await act(() => Promise.resolve());
    const list = document.querySelector(".dv-tabs-container");
    if (!list) throw new Error("no tab list");
    list.scrollLeft = 0;
    resizes.report(700);
    expect(list.scrollLeft).toBe(400);
    expect(into).not.toHaveBeenCalled();
    expect(
      [...document.querySelectorAll("*")].filter(
        (element) =>
          element !== list &&
          (element.scrollLeft !== 0 || element.scrollTop !== 0),
      ),
    ).toEqual([]);
  } finally {
    resizes.restore();
    Reflect.deleteProperty(HTMLElement.prototype, "offsetLeft");
    Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
    Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
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
