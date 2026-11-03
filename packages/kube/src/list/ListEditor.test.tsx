import {
  act,
  cleanup,
  configure,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMockBackend } from "@twigo/protocol/mock";
import type { QuickAccessContext } from "@twigo/workbench";
import { openList, settle, withScreenSize } from "../../test/workbench";
import { cellTone } from "../columns";
import { DWELL_MS } from "../Details";
import { PODS } from "../kinds";
import { parseListUri } from "../uri";

withScreenSize();

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

const NOWHERE: QuickAccessContext = { lookup: () => undefined };
const rows = () => screen.getAllByRole("row").slice(1);
const cellOf = (row: HTMLElement | undefined, column: string) =>
  row?.querySelector(`[data-column="${column}"]`)?.textContent ?? "";
const nameOf = (row: HTMLElement | undefined) => cellOf(row, "Name");
const statusOf = (row: HTMLElement) => cellOf(row, "Status");
const details = () =>
  screen.queryByRole("complementary", { name: "Pod details" });
const grid = () => screen.getByRole("grid");
const focusGrid = () => {
  act(() => {
    grid().focus();
  });
};
const key = (code: string, init: KeyboardEventInit = {}) => {
  fireEvent.keyDown(grid(), { code, key: code, ...init });
};
const health = (name: string) =>
  within(screen.getByRole("group", { name: "Rows by health" })).getByRole(
    "button",
    { name: new RegExp(`^${name}`) },
  );
const filterField = () => screen.getByRole("textbox", { name: "Filter rows" });
const openMenu = (trigger: HTMLElement) => {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
};
const clipboard = () => {
  const writeText = vi.fn((_text: string) => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
};

test("a click opens the row's details over the list, arrows follow, Escape closes", async () => {
  await openList();
  expect(details()).toBeNull();
  const [first, second] = rows();
  if (!first || !second) throw new Error("no rows");
  fireEvent.click(first);
  expect(details()?.textContent).toContain(nameOf(first));
  focusGrid();
  key("KeyJ");
  await settle(2);
  expect(details()?.textContent).toContain(nameOf(second));
  key("Escape");
  expect(details()).toBeNull();
});

test("Enter on the selected row opens its details", async () => {
  await openList();
  focusGrid();
  key("KeyJ");
  await settle(2);
  expect(details()).toBeNull();
  key("Enter");
  expect(details()).not.toBeNull();
});

test("a health shows only its rows while every count stays, All counting every row", async () => {
  await openList();
  const counts = () =>
    ["All", "Failing", "Pending", "Healthy"].map(
      (name) => health(name).textContent,
    );
  const before = counts();
  expect(before[0]).toBe("All5,000");
  fireEvent.click(health("Failing"));
  await settle();
  expect(health("Failing").getAttribute("aria-pressed")).toBe("true");
  expect(rows().length).toBeGreaterThan(0);
  expect(
    rows().filter((row) => cellTone(PODS, "Status", statusOf(row)) !== "error"),
  ).toEqual([]);
  expect(counts()).toEqual(before);
  fireEvent.click(health("All"));
  await settle();
  expect(screen.getByText("5,000 pods")).toBeTruthy();
});

test("All on a list whose URI picks a health shows every row", async () => {
  await openList(
    createMockBackend("ready"),
    "k8s-list://prod-eu/v1/pods?h=warn",
  );
  expect(health("Pending").getAttribute("aria-pressed")).toBe("true");
  expect(rows().length).toBeGreaterThan(0);
  expect(
    rows().filter((row) => cellTone(PODS, "Status", statusOf(row)) !== "warn"),
  ).toEqual([]);
  fireEvent.click(health("All"));
  await settle();
  expect(health("All").getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByText("5,000 pods")).toBeTruthy();
  expect(
    rows().some((row) => cellTone(PODS, "Status", statusOf(row)) !== "warn"),
  ).toBe(true);
});

test("/ in the list focuses the filter field, and its text filters the rows", async () => {
  await openList();
  focusGrid();
  key("Slash");
  expect(document.activeElement).toBe(filterField());
  fireEvent.change(filterField(), { target: { value: "ImagePullBackOff" } });
  await settle();
  expect(rows().length).toBeGreaterThan(0);
  expect(rows().filter((row) => statusOf(row) !== "ImagePullBackOff")).toEqual(
    [],
  );
});

test("the filter field takes the focus when / asks for it, not each time the list shows again", async () => {
  const workbench = await openList();
  const pods = "k8s-list://prod-eu/v1/pods";
  const object = `k8s://prod-eu//v1/pods/${cellOf(rows()[0], "Namespace")}/${nameOf(rows()[0])}`;
  focusGrid();
  key("Slash");
  expect(document.activeElement).toBe(filterField());

  for (const other of ["k8s-list://prod-eu/v1/nodes", object]) {
    act(() => {
      workbench.editors.open(other, { preview: false });
    });
    await settle();
    act(() => {
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
    });
    act(() => {
      workbench.editors.open(pods);
    });
    await settle();
    expect(document.activeElement).not.toBe(filterField());
  }

  focusGrid();
  key("Slash");
  expect(document.activeElement).toBe(filterField());
});

test("a row's actions button and a right click run the resource commands on that row", async () => {
  const writeText = clipboard();
  await openList();
  const second = rows()[1];
  if (!second) throw new Error("no rows");
  const name = nameOf(second);
  const namespace = cellOf(second, "Namespace");
  expect(name).not.toBe("");
  expect(namespace).not.toBe("");
  const trigger = within(second).getByRole("button", { name: "Row actions" });
  openMenu(trigger);
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Copy Namespace/Name" }),
  );
  await settle(1);
  expect(writeText).toHaveBeenCalledWith(`${namespace}/${name}`);

  const third = rows()[2];
  if (!third) throw new Error("no rows");
  fireEvent.contextMenu(third);
  fireEvent.click(screen.getByRole("menuitem", { name: "Open Details" }));
  await settle(1);
  expect(details()?.textContent).toContain(nameOf(third));
});

test("a row's hover buttons show before any row is selected, and act on their row", async () => {
  const writeText = clipboard();
  await openList();
  const second = rows()[1];
  if (!second) throw new Error("no rows");
  expect(
    rows().filter((row) => row.getAttribute("aria-selected") === "true"),
  ).toEqual([]);
  fireEvent.click(within(second).getByRole("button", { name: "Copy Name" }));
  await settle(1);
  expect(writeText).toHaveBeenCalledWith(nameOf(second));
});

test("the column chooser shows a wide column, and the kind keeps the choice", async () => {
  const backend = createMockBackend("ready");
  await openList(backend);
  expect(screen.queryByRole("columnheader", { name: "IP" })).toBeNull();
  openMenu(screen.getByRole("button", { name: "Choose columns" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "IP" }));
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await settle(1);
  expect(screen.getByRole("columnheader", { name: "IP" })).toBeTruthy();

  cleanup();
  await openList(backend);
  expect(screen.getByRole("columnheader", { name: "IP" })).toBeTruthy();
});

test("two lists of a space keep their own selected row for the details and the row commands", async () => {
  const writeText = clipboard();
  const workbench = await openList();
  const all = nameOf(rows()[0]);
  expect(all).not.toBe("");
  fireEvent.click(rows()[0] ?? document.body);
  act(() => {
    workbench.editors.open("k8s-list://prod-eu/v1/pods?ns=payments");
  });
  await settle();
  const payments = nameOf(rows()[1]);
  expect(payments).not.toBe(all);
  fireEvent.click(rows()[1] ?? document.body);
  expect(details()?.textContent).toContain(payments);

  act(() => {
    workbench.editors.open("k8s-list://prod-eu/v1/pods");
  });
  await settle();
  expect(details()?.textContent).toContain(all);
  fireEvent.click(
    within(details() ?? document.body).getByRole("button", {
      name: "Copy Name",
    }),
  );
  await settle(1);
  expect(writeText).toHaveBeenCalledWith(all);
});

test("a list whose space comes back keeps its health and subscribes with that health's values", async () => {
  const backend = createMockBackend("ready");
  const workbench = await openList(backend);
  fireEvent.click(health("Failing"));
  await settle();
  act(() => {
    workbench.spaces.select("staging");
  });
  await settle();
  const subscribe = vi.spyOn(backend, "subscribe");
  act(() => {
    workbench.spaces.select("prod-eu");
  });
  await settle();
  expect(health("Failing").getAttribute("aria-pressed")).toBe("true");
  const values = subscribe.mock.calls.flatMap(([command, query]) =>
    command === "list_subscribe" &&
    typeof query === "object" &&
    query !== null &&
    "values" in query
      ? [query.values?.values]
      : [],
  );
  expect(values).toEqual([["CrashLoopBackOff", "Error", "ImagePullBackOff"]]);
  expect(rows().length).toBeGreaterThan(0);
});

test("going to a pod again shows its details again after they were closed", async () => {
  const workbench = await openList();
  const provider = workbench.quickAccess.resolve("auth-api-1a4")?.provider;
  if (!provider) throw new Error("no provider");
  const goTo = async () => {
    const pending = provider.items("auth-api-1a4", NOWHERE);
    await settle();
    const [first] = await pending;
    if (!first) throw new Error("no pods");
    await act(() => provider.accept(first, "auth-api-1a4", NOWHERE));
    await settle();
    return first.label;
  };
  const name = await goTo();
  expect(details()?.textContent).toContain(name);
  fireEvent.click(screen.getByRole("button", { name: "Close details" }));
  expect(details()).toBeNull();
  await goTo();
  expect(details()?.textContent).toContain(name);

  fireEvent.change(filterField(), { target: { value: "" } });
  await settle();
  const other = rows().find((row) => nameOf(row) !== name);
  fireEvent.click(other ?? document.body);
  expect(details()?.textContent).toContain(nameOf(other));
  await goTo();
  expect(details()?.textContent).toContain(name);
  const selected = rows().filter(
    (row) => row.getAttribute("aria-selected") === "true",
  );
  expect(selected.map(nameOf)).toEqual([name]);
});

test("a list subscribes with the scope discovery gives, and waits for it", async () => {
  const mock = createMockBackend("ready");
  const queries: unknown[] = [];
  let answer: (() => void) | undefined;
  const backend: typeof mock = {
    invoke: (command, request) => mock.invoke(command, request),
    subscribe(command, request, onMessage) {
      if (command === "list_subscribe") queries.push(request);
      if (command !== "resources_watch") {
        return mock.subscribe(command, request, onMessage);
      }
      answer = () => void mock.subscribe(command, request, onMessage);
      return Promise.resolve(null as never);
    },
  };
  await openList(backend);
  expect(queries).toEqual([]);
  act(() => answer?.());
  await settle();
  expect(queries).toMatchObject([{ namespaced: true }]);
  expect(rows().length).toBeGreaterThan(0);
});

test("a kind the cluster does not serve says so instead of a list", async () => {
  const workbench = await openList();
  act(() => {
    workbench.editors.open("k8s-list://prod-eu/example.com/v1/widgets");
  });
  await settle();
  expect(
    screen.getByText("The cluster does not serve widgets.example.com"),
  ).toBeDefined();
});

test("a list of a version discovery does not prefer subscribes with that resource's scope", async () => {
  const mock = createMockBackend("ready");
  const queries: unknown[] = [];
  const backend: typeof mock = {
    invoke: (command, request) => mock.invoke(command, request),
    subscribe(command, request, onMessage) {
      if (command === "list_subscribe") queries.push(request);
      return mock.subscribe(command, request, onMessage);
    },
  };
  const workbench = await openList(backend);
  queries.length = 0;
  act(() => {
    workbench.editors.open(
      "k8s-list://prod-eu/autoscaling/v1/horizontalpodautoscalers",
    );
  });
  await settle();
  expect(queries).toMatchObject([
    {
      gvr: { group: "autoscaling", version: "v1" },
      namespaced: true,
    },
  ]);
});

test("a failed discovery shows its error instead of a list", async () => {
  const mock = createMockBackend("ready");
  const backend: typeof mock = {
    invoke: (command, request) => mock.invoke(command, request),
    subscribe(command, request, onMessage) {
      if (command !== "resources_watch") {
        return mock.subscribe(command, request, onMessage);
      }
      setTimeout(() => {
        (onMessage as (message: unknown) => void)({
          state: "failed",
          error: { kind: "unavailable", message: "no route to the cluster" },
        });
      }, 0);
      return Promise.resolve(null as never);
    },
  };
  await openList(backend);
  const title = screen.getByText("Could not load pods");
  const state = title.parentElement ?? title;
  expect(within(state).getByText("no route to the cluster")).toBeDefined();
  expect(screen.queryByRole("grid", { name: "Pods" })).toBeNull();
});

test("the details open the object once the selection rests on a row, not while it moves", async () => {
  const backend = createMockBackend("ready");
  const subscribe = vi.spyOn(backend, "subscribe");
  await openList(backend);
  const opened = () =>
    subscribe.mock.calls.filter(([command]) => command === "object_open");
  const [first] = rows();
  if (!first) throw new Error("no rows");
  fireEvent.click(first);
  focusGrid();
  for (let i = 0; i < 5; i++) {
    key("KeyJ");
    await act(() => vi.advanceTimersByTimeAsync(DWELL_MS / 3));
  }
  expect(opened()).toHaveLength(0);
  await settle();
  expect(opened()).toHaveLength(1);
  const shown = rows().find(
    (row) => row.getAttribute("aria-selected") === "true",
  );
  expect(opened()[0]?.[1]).toMatchObject({
    object: {
      namespaced: true,
      namespace: cellOf(shown, "Namespace"),
      name: nameOf(shown),
    },
  });
  expect(
    within(details() ?? document.body).getByRole("region", {
      name: "Metadata",
    }),
  ).toBeDefined();
});

test("opening the object from the details keeps the list in a tab of its own", async () => {
  const workbench = await openList();
  act(() => {
    workbench.editors.close("k8s-list://prod-eu/v1/pods");
  });
  act(() => {
    workbench.editors.open("k8s-list://prod-eu/v1/pods", { preview: true });
  });
  await settle();
  const [first] = rows();
  if (!first) throw new Error("no rows");
  fireEvent.click(first);
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Open in an editor" }));
  await settle();
  const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent.trim());
  expect(tabs[0]).toBe("Pods");
  expect(tabs).toHaveLength(2);
  expect(workbench.editors.active).toMatch(/^k8s:\/\/prod-eu\/\/v1\/pods\//);
});

test("the details say why the object cannot open, over the row's cells", async () => {
  const mock = createMockBackend("ready");
  const backend: typeof mock = {
    invoke: (command, request) => mock.invoke(command, request),
    subscribe(command, request, onMessage) {
      if (command === "object_open")
        return Promise.reject(
          new Error("Command object_open not allowed by ACL"),
        );
      return mock.subscribe(command, request, onMessage);
    },
  };
  await openList(backend);
  const [first] = rows();
  if (!first) throw new Error("no rows");
  fireEvent.click(first);
  await settle();
  expect(details()?.textContent).toContain(
    "Command object_open not allowed by ACL",
  );
  expect(details()?.textContent).toContain("Ready");
});

test("the details show the document of the row the selection rests on", async () => {
  await openList();
  const [first, second] = rows();
  if (!first || !second) throw new Error("no rows");
  fireEvent.click(first);
  await settle();
  const metadata = () =>
    within(details() ?? document.body).getByRole("region", {
      name: "Metadata",
    }).textContent;
  expect(metadata()).toContain(nameOf(first));
  focusGrid();
  key("KeyJ");
  await settle();
  expect(metadata()).toContain(nameOf(second));
  expect(metadata()).not.toContain(nameOf(first));
});

const markBar = () =>
  screen
    .queryAllByRole("toolbar")
    .find((bar) => bar.textContent.includes("marked")) ?? null;
const isMarked = (row: HTMLElement | undefined) =>
  row?.querySelector("[role=checkbox]")?.getAttribute("aria-checked");

test("a row's box marks it, x marks the cursor's row, shift+down marks while moving, and Copy Names copies their names sorted", async () => {
  const writeText = clipboard();
  await openList();
  expect(markBar()).toBeNull();
  const fourth = rows()[3];
  fireEvent.click(
    within(fourth ?? document.body).getByRole("checkbox", { name: "Mark row" }),
  );
  await settle(1);
  expect(markBar()?.textContent).toContain("1 marked");

  focusGrid();
  key("KeyJ");
  await settle(2);
  key("KeyX");
  await settle(1);
  expect(markBar()?.textContent).toContain("2 marked");

  key("ArrowDown", { shiftKey: true });
  await settle(2);
  expect(rows().slice(0, 4).map(isMarked)).toEqual([
    "true",
    "true",
    "false",
    "true",
  ]);
  expect(markBar()?.textContent).toContain("3 marked");

  const marked = [fourth, rows()[0], rows()[1]].map(nameOf);
  expect(marked.filter((name) => name === "")).toEqual([]);
  fireEvent.click(
    within(markBar() ?? document.body).getByRole("button", {
      name: /^Copy Names/,
    }),
  );
  await settle(1);
  expect(writeText).toHaveBeenCalledWith([...marked].sort().join("\n"));
  expect([...marked].sort()).not.toEqual(marked);
});

test("a change of the list's text, health or namespaces clears its marks, its space coming back does not", async () => {
  const workbench = await openList();
  const mark = async () => {
    fireEvent.click(
      within(rows()[0] ?? document.body).getByRole("checkbox", {
        name: "Mark row",
      }),
    );
    await settle(1);
    expect(markBar()?.textContent).toContain("1 marked");
  };
  await mark();
  for (const space of ["staging", "prod-eu"]) {
    act(() => {
      workbench.spaces.select(space);
    });
    await settle();
  }
  expect(markBar()?.textContent).toContain("1 marked");

  fireEvent.change(filterField(), { target: { value: "api" } });
  await settle();
  expect(markBar()).toBeNull();

  await mark();
  fireEvent.click(health("Failing"));
  await settle();
  expect(markBar()).toBeNull();

  await mark();
  act(() => {
    workbench.spaces.update("prod-eu", (state) => ({
      ...state,
      namespaces: ["auth"],
    }));
  });
  await settle();
  expect(markBar()).toBeNull();
});

test("Escape closes the details first, then clears the marks", async () => {
  await openList();
  const [first, second] = rows();
  if (!first || !second) throw new Error("no rows");
  fireEvent.click(within(second).getByRole("checkbox", { name: "Mark row" }));
  fireEvent.click(first);
  await settle(1);
  expect(details()).not.toBeNull();
  expect(markBar()?.textContent).toContain("1 marked");
  focusGrid();
  key("Escape");
  await settle(1);
  expect(details()).toBeNull();
  expect(markBar()?.textContent).toContain("1 marked");
  key("Escape");
  await settle(1);
  expect(markBar()).toBeNull();
  expect(isMarked(rows()[1])).toBe("false");
});

const pinButton = (label: string) =>
  screen.getByRole("button", { name: label });
const explorer = () => screen.getByRole("tree", { name: "Resources" });

test("a cluster-scoped list keeps its marks as the namespace scope changes", async () => {
  const workbench = await openList(undefined, "k8s-list://prod-eu/v1/nodes");
  const before = rows().map((row) => row.textContent);
  fireEvent.click(
    within(rows()[0] ?? document.body).getByRole("checkbox", {
      name: "Mark row",
    }),
  );
  await settle(1);
  expect(markBar()?.textContent).toContain("1 marked");
  act(() => {
    workbench.spaces.update("prod-eu", (state) => ({
      ...state,
      namespaces: ["auth"],
    }));
  });
  await settle();
  expect(rows().map((row) => row.textContent)).toEqual(before);
  expect(markBar()?.textContent).toContain("1 marked");
});

test("the pin keeps the list with its namespaces, text and health, opens it so, and unpins on a second press", async () => {
  const workbench = await openList();
  act(() => {
    workbench.spaces.update("prod-eu", (state) => ({
      ...state,
      namespaces: ["auth", "payments"],
    }));
  });
  await settle();
  fireEvent.click(health("Failing"));
  fireEvent.change(filterField(), { target: { value: "api" } });
  await settle();
  expect(within(explorer()).queryByText("Pinned")).toBeNull();
  fireEvent.click(pinButton("Pin to the explorer"));
  await settle(1);

  expect(within(explorer()).getByText("Pinned")).toBeTruthy();
  const pinned = within(explorer()).getByRole("treeitem", {
    name: /^PodsFailing · auth, payments · “api”/,
  });
  fireEvent.click(pinned);
  await settle();
  const uri = workbench.editors.active ?? "";
  expect(parseListUri(uri)).toEqual({
    space: "prod-eu",
    gvr: PODS,
    namespaces: ["auth", "payments"],
    text: "api",
    health: "error",
  });
  expect(health("Failing").getAttribute("aria-pressed")).toBe("true");
  expect(filterField()).toHaveProperty("value", "api");
  expect(rows().length).toBeGreaterThan(0);
  expect(
    rows().filter((row) => cellTone(PODS, "Status", statusOf(row)) !== "error"),
  ).toEqual([]);

  fireEvent.click(pinButton("Unpin from the explorer"));
  await settle(1);
  expect(within(explorer()).queryByText("Pinned")).toBeNull();
  expect(pinButton("Pin to the explorer")).toBeTruthy();
});

test("a list opens with the text and health of its URI, and keeps what is picked in it while it stays open", async () => {
  const uri = "k8s-list://prod-eu/v1/pods?q=api&h=error";
  const workbench = await openList(createMockBackend("ready"), uri);
  fireEvent.click(pinButton("Pin to the explorer"));
  await settle(1);
  fireEvent.click(health("All"));
  fireEvent.change(filterField(), { target: { value: "web" } });
  await settle();
  act(() => {
    workbench.editors.open("k8s-list://prod-eu/v1/nodes", { preview: false });
  });
  await settle();
  act(() => {
    workbench.editors.open(uri);
  });
  await settle();
  expect(health("All").getAttribute("aria-pressed")).toBe("true");
  expect(filterField()).toHaveProperty("value", "web");

  act(() => {
    workbench.editors.close(uri);
  });
  await settle();
  fireEvent.click(
    within(explorer()).getByRole("treeitem", { name: /^PodsFailing · “api”/ }),
  );
  await settle();
  expect(workbench.editors.active).toBe(uri);
  expect(health("Failing").getAttribute("aria-pressed")).toBe("true");
  expect(filterField()).toHaveProperty("value", "api");
  expect(pinButton("Unpin from the explorer")).toBeTruthy();
});

test("under StrictMode a list keeps what is picked in it as its space comes back, and takes its URI's once closed", async () => {
  const uri = "k8s-list://prod-eu/v1/pods?h=error";
  configure({ reactStrictMode: true });
  try {
    const workbench = await openList(createMockBackend("ready"), uri);
    fireEvent.click(health("All"));
    fireEvent.change(filterField(), { target: { value: "api" } });
    await settle();
    for (const space of ["staging", "prod-eu"]) {
      act(() => {
        workbench.spaces.select(space);
      });
      await settle();
    }
    expect(health("All").getAttribute("aria-pressed")).toBe("true");
    expect(filterField()).toHaveProperty("value", "api");

    act(() => {
      workbench.editors.close(uri);
    });
    await settle();
    act(() => {
      workbench.editors.open(uri);
    });
    await settle();
    expect(health("Failing").getAttribute("aria-pressed")).toBe("true");
    expect(filterField()).toHaveProperty("value", "");
  } finally {
    configure({ reactStrictMode: false });
  }
});
