import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  BLOCKED_AFTER_MS,
  createMockBackend,
  READY_AFTER_MS,
  type MockScenario,
} from "@twigo/protocol/mock";
import type { Workbench } from "@twigo/workbench";
import { mountKube, settle, withScreenSize } from "../../test/workbench";
import { pfUri } from "../uri";

withScreenSize(1400);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  history.replaceState(null, "", "/");
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** Mounts the whole workbench on prod-eu, where forwardRestored keeps three forwards, and shows the Port forwards. */
async function mounted(scenario: MockScenario = "forwardRestored") {
  const backend = createMockBackend(scenario);
  const invoke = vi.spyOn(backend, "invoke");
  const workbench = await mountKube(backend);
  fireEvent.click(screen.getByRole("tab", { name: "Port forwards" }));
  await settle(6);
  return {
    workbench,
    backend,
    calls: (command: string): unknown[] =>
      invoke.mock.calls
        .filter(([name]) => name === command)
        .map(([, request]) => request),
  };
}

const grid = () => screen.getByRole("grid", { name: "Port forwards" });
const rows = () => within(grid()).getAllByRole("row");
const line = (row: HTMLElement | undefined) =>
  row?.querySelector('[data-fit="forward"] > span') ?? undefined;
const parts = (row: HTMLElement | undefined) =>
  [...(line(row)?.children ?? [])].map((part) =>
    part.tagName === "svg"
      ? "icon"
      : part.classList.contains("rounded-full")
        ? "dot"
        : part.textContent,
  );
const dot = (row: HTMLElement | undefined) =>
  line(row)?.querySelector(".rounded-full");
const stateWords = (row: HTMLElement | undefined) => {
  const all = parts(row);
  return all.length === 5 ? all[3] : undefined;
};
const tooltip = async (target: HTMLElement | undefined) => {
  const trigger = line(target);
  if (!trigger) throw new Error("no line");
  fireEvent.focus(trigger);
  await settle(2);
  const text = screen.getByRole("tooltip").textContent;
  fireEvent.blur(trigger);
  await settle(2);
  return text;
};
const press = (code: string, init: KeyboardEventInit = {}) => {
  fireEvent.keyDown(grid(), { code, key: code, ...init });
};
const focusGrid = () => {
  act(() => {
    grid().focus();
  });
};
const stop = () =>
  screen.queryByRole("button", { name: "Stop All Port Forwards" });
const stopAll = (): HTMLElement => {
  const button = stop();
  if (!button) throw new Error("no Stop All");
  return button;
};
const row = (n: number): HTMLElement => {
  const found = rows()[n];
  if (!found) throw new Error(`no row ${String(n)}`);
  return found;
};

/** Moves the cursor to the nth row by the keyboard, which selects without opening. */
async function select(n: number) {
  focusGrid();
  for (let i = 0; i <= n; i++) press("ArrowDown", { key: "ArrowDown" });
  await settle(4);
}

const panelTabs = (workbench: Workbench) => workbench.editors.active;

test("the Port forwards container joins the Explorer in the side bar's header, and lists the space's forwards as one line each, without column headers", async () => {
  await mounted();
  screen.getByRole("tab", { name: "Explorer" });
  expect(
    screen.getByRole("tab", { name: "Port forwards", selected: true }),
  ).toBeTruthy();
  expect(within(grid()).queryAllByRole("columnheader")).toEqual([]);
  expect(rows().map(parts)).toEqual([
    ["dot", "icon", "payments-api:http", "Restored", "→ 8081"],
    ["dot", "icon", "payments-gateway:metrics", "Stopped", "→ 9090"],
    ["dot", "icon", "payments-legacy:http", "Failed", "→ 8082"],
  ]);
});

test("the state's words show only while a forward is not ready, and a ready row's dot says its state instead", async () => {
  const { backend } = await mounted();
  expect(rows().map(stateWords)).toEqual(["Restored", "Stopped", "Failed"]);
  expect(rows().map((row) => dot(row)?.getAttribute("aria-hidden"))).toEqual([
    "true",
    "true",
    "true",
  ]);

  await act(() => backend.invoke("forward_resume", { id: 2, local: null }));
  await act(() => vi.advanceTimersByTimeAsync(700));
  expect(parts(row(1))).toEqual([
    "dot",
    "icon",
    "payments-gateway:metrics",
    "→ 9090",
  ]);
  expect(stateWords(row(1))).toBeUndefined();
  expect(dot(row(1))?.getAttribute("role")).toBe("img");
  expect(dot(row(1))?.getAttribute("aria-label")).toBe("Ready");
});

test("the dot keeps the state's tone, and pulses while the state is in flight", async () => {
  const { backend } = await mounted();
  const tones = () => rows().map((row) => dot(row)?.className ?? "");
  expect(tones()[0]).toContain("bg-muted-foreground-2");
  expect(tones()[2]).toContain("bg-error");
  expect(tones()[2]).not.toContain("animate-pulse");

  await act(() =>
    backend.invoke("forward_start", {
      target: {
        space: "prod-eu",
        gvr: { group: "", version: "v1", resource: "services" },
        namespace: "payments",
        name: "payments-gateway",
      },
      port: 80,
      local: null,
    }),
  );
  await settle(2);
  expect(stateWords(row(3))).toBe("Starting");
  expect(tones()[3]).toContain("animate-pulse");

  await act(() => vi.advanceTimersByTimeAsync(READY_AFTER_MS + 100));
  expect(stateWords(row(3))).toBeUndefined();
  expect(tones()[3]).toContain("bg-ok");
  expect(tones()[3]).not.toContain("animate-pulse");
});

test("a row's tooltip carries its kind, its ports, its state with the reason, and its pod", async () => {
  const { backend } = await mounted();
  const failed = await tooltip(row(2));
  expect(failed).toContain("Deployment payments-legacy");
  expect(failed).toContain("http 8080 → localhost:8082");
  expect(failed).toContain(
    'Failed · deployments.apps "payments-legacy" not found',
  );
  expect(failed).not.toContain("Pod ");

  await act(() => backend.invoke("forward_resume", { id: 2, local: null }));
  await act(() => vi.advanceTimersByTimeAsync(700));
  const ready = await tooltip(row(1));
  expect(ready).toContain("Service payments-gateway");
  expect(ready).toContain("metrics 9090 → localhost:9090");
  expect(ready).toContain("Ready");
  expect(ready).toMatch(/Pod payments-gateway-\S+$/);
});

test("a failed row has an edge in its tone, and a ready one has none", async () => {
  const { backend } = await mounted();
  await act(() => backend.invoke("forward_resume", { id: 2, local: null }));
  await act(() => vi.advanceTimersByTimeAsync(700));
  const [, ready, failed] = rows();
  expect(failed?.className).toContain("--error");
  expect(ready?.className).not.toContain("--error");
});

test("with no forwards the view says how to start one", async () => {
  await mounted("live");
  screen.getByText("No port forwards");
  screen.getByText(/press f to forward a port of it to this machine/);
  expect(stop()).toBeNull();
});

test("Enter opens the selected forward's tab, which holds the keys of the list", async () => {
  const { workbench } = await mounted();
  await select(1);
  press("Enter");
  await settle(6);
  expect(panelTabs(workbench)).toBe(pfUri({ space: "prod-eu", id: 2 }));
});

test("a click opens the forward's tab as a preview", async () => {
  const { workbench } = await mounted();
  const open = vi.spyOn(workbench.editors, "open");
  fireEvent.click(row(2));
  await settle(6);
  expect(open).toHaveBeenCalledWith(pfUri({ space: "prod-eu", id: 3 }), {
    preview: true,
    preserveFocus: true,
  });
});

test("⌘C copies the selected forward's address, and ⌫ and Delete remove it", async () => {
  const { calls } = await mounted();
  const write = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: write },
  });
  await select(0);
  press("KeyC", { key: "c", metaKey: true });
  await settle(4);
  expect(write).toHaveBeenCalledWith("localhost:8081");

  press("Backspace");
  await settle(6);
  expect(calls("forward_remove")).toEqual([1]);
  expect(rows().map(stateWords)).toEqual(["Stopped", "Failed"]);

  await select(0);
  press("Delete");
  await settle(6);
  expect(calls("forward_remove")).toEqual([1, 2]);
});

test("the keys of the list do nothing without a selected row, or once the focus has left the list", async () => {
  const { calls } = await mounted();
  focusGrid();
  press("Backspace");
  press("Delete");
  await settle(4);
  expect(calls("forward_remove")).toEqual([]);

  await select(0);
  act(() => {
    document.body.focus();
  });
  fireEvent.keyDown(document.body, { code: "Backspace", key: "Backspace" });
  fireEvent.keyDown(document.body, { code: "Delete", key: "Delete" });
  await settle(4);
  expect(calls("forward_remove")).toEqual([]);
});

test("the first right click on a row opens its menu, which carries the tab's actions for its state", async () => {
  await mounted();
  const menuOf = async (n: number) => {
    fireEvent.contextMenu(row(n));
    await settle(4);
    const items = within(screen.getByRole("menu"))
      .getAllByRole("menuitem")
      .map((item) => item.querySelector("span")?.textContent);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await settle(4);
    return items;
  };
  expect(await menuOf(0)).toEqual([
    "Open",
    "Open in Browser",
    "Copy Address",
    "Stop",
    "Change Local Port…",
    "Remove",
  ]);
  expect(await menuOf(1)).toEqual([
    "Open",
    "Open in Browser",
    "Copy Address",
    "Start",
    "Change Local Port…",
    "Remove",
  ]);
  expect(await menuOf(2)).toEqual([
    "Open",
    "Open in Browser",
    "Copy Address",
    "Stop",
    "Start",
    "Change Local Port…",
    "Remove",
  ]);
});

test("Stop all in the view's title stops the space's running forwards, not the stopped ones, and goes when none runs", async () => {
  const { calls } = await mounted();
  fireEvent.click(stopAll());
  await settle(6);
  expect(calls("forward_stop")).toEqual([1, 3]);
  expect(rows().map(stateWords)).toEqual(["Stopped", "Stopped", "Stopped"]);
  expect(stop()).toBeNull();
});

test("Stop all leaves the forwards of other spaces running", async () => {
  const { backend, calls } = await mounted();
  await act(() => backend.invoke("space_open", "qa"));
  await act(() =>
    backend.invoke("forward_start", {
      target: {
        space: "qa",
        gvr: { group: "", version: "v1", resource: "services" },
        namespace: "auth",
        name: "auth-api",
      },
      port: 80,
      local: 8099,
    }),
  );
  await act(() => vi.advanceTimersByTimeAsync(700));
  fireEvent.click(stopAll());
  await settle(6);
  expect(calls("forward_stop")).toEqual([1, 3]);
});

test("forwards of other spaces are not listed", async () => {
  const { workbench } = await mounted();
  await act(() => workbench.spaces.open("qa"));
  act(() => {
    workbench.spaces.select("qa");
  });
  await settle(6);
  fireEvent.click(screen.getByRole("tab", { name: "Port forwards" }));
  await settle(4);
  screen.getByText("No port forwards");
});

test("the list follows the core: a forward that is added or removed shows at once", async () => {
  const { backend } = await mounted();
  expect(rows()).toHaveLength(3);
  await act(() => backend.invoke("forward_remove", 2));
  await settle(4);
  expect(rows().map(stateWords)).toEqual(["Restored", "Failed"]);
  await act(() =>
    backend.invoke("forward_start", {
      target: {
        space: "prod-eu",
        gvr: { group: "", version: "v1", resource: "services" },
        namespace: "payments",
        name: "payments-gateway",
      },
      port: 9090,
      local: null,
    }),
  );
  await settle(4);
  expect(rows()).toHaveLength(3);
});

test("a row's menu shows the keys that do the same", async () => {
  await mounted();
  await select(0);
  fireEvent.contextMenu(row(0));
  await settle(4);
  expect(
    screen.getByRole("menuitem", { name: /^Copy Address/ }).textContent,
  ).toContain("⌘C");
  expect(
    screen.getByRole("menuitem", { name: /^Remove/ }).textContent,
  ).toContain("⌫");
});

test("a forward that the mode refuses is a row in the warning tone that says the mode", async () => {
  const { backend } = await mounted("forwardBlocked");
  await act(() =>
    backend.invoke("forward_start", {
      target: {
        space: "prod-eu",
        gvr: { group: "", version: "v1", resource: "services" },
        namespace: "payments",
        name: "payments-api",
      },
      port: 80,
      local: null,
    }),
  );
  await act(() =>
    vi.advanceTimersByTimeAsync(READY_AFTER_MS + BLOCKED_AFTER_MS + 100),
  );
  expect(stateWords(row(0))).toBe("Read-only");
  expect(row(0).className).toContain("--warn");
  expect(row(0).className).not.toContain("--error");
});
