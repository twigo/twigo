import {
  act,
  cleanup,
  configure,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { useCallback } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ListBatch, RequestOf, Row } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import {
  hoverIcons,
  mountKube,
  openList,
  scriptedBackend,
  settle,
  withScreenSize,
} from "../../test/workbench";

const gridRenders = vi.hoisted(() => ({ count: 0, rows: [] as string[] }));

vi.mock("@twigo/ui", async (original) => {
  const ui = await original<typeof import("@twigo/ui")>();
  return {
    ...ui,
    DataGrid: (props: Parameters<typeof ui.DataGrid>[0]) => {
      gridRenders.count++;
      const { cell } = props;
      const counted = useCallback<typeof cell>(
        (row, column) => {
          if (column.id === "Name") gridRenders.rows.push((row as Row).id);
          return cell(row, column);
        },
        [cell],
      );
      return <ui.DataGrid {...props} cell={counted} />;
    },
  };
});

const layout = withScreenSize(1280);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  gridRenders.rows = [];
});

const header = (name: string) => screen.getByRole("columnheader", { name });
const template = () =>
  screen.getAllByRole("row")[0]?.style.gridTemplateColumns ?? "";
const rows = () => screen.getAllByRole("row").slice(1);
const cellOf = (row: HTMLElement | undefined, column: string) =>
  row?.querySelector<HTMLElement>(`[data-column="${column}"]`) ?? undefined;
const textOf = (row: HTMLElement | undefined, column: string) =>
  cellOf(row, column)?.textContent ?? "";
const grid = () => screen.getByRole("grid");
const key = (code: string) => {
  fireEvent.keyDown(grid(), { code, key: code });
};
const focusGrid = () => {
  act(() => {
    grid().focus();
  });
};
const openMenu = (trigger: HTMLElement) => {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
};

test("rows from the window render with the server's priority-0 columns", async () => {
  await openList();
  const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
  expect(headers).toEqual([
    "",
    "Name",
    "Namespace",
    "Ready",
    "Status",
    "Restarts",
    "CPU",
    "Memory",
    "Age",
    "",
  ]);
  expect(rows().length).toBeGreaterThan(10);
});

test("clicking a header sorts by that column, then reverses, keeping rows on screen", async () => {
  await openList();
  fireEvent.click(within(header("Ready")).getByRole("button"));
  expect(rows().length).toBeGreaterThan(10);
  await settle();
  expect(header("Ready").getAttribute("aria-sort")).toBe("ascending");
  const cells = () =>
    rows()
      .slice(0, 3)
      .map((row) => textOf(row, "Ready"));
  expect(cells()).toEqual(["0/1", "0/1", "0/1"]);
  fireEvent.click(within(header("Ready")).getByRole("button"));
  await settle();
  expect(header("Ready").getAttribute("aria-sort")).toBe("descending");
  expect(cells()).toEqual(["3/3", "3/3", "3/3"]);
});

test("a space without pods shows the empty state, not an error", async () => {
  const workbench = await mountKube(createMockBackend("live"));
  act(() => {
    workbench.spaces.select("dev");
  });
  await settle();
  act(() => {
    workbench.editors.open("k8s-list://dev/v1/pods");
  });
  await settle(30);
  expect(screen.getByText("No pods in dev")).toBeTruthy();
});

test("an empty list names its space, then the namespaces it is narrowed to", async () => {
  const workbench = await mountKube(createMockBackend("live"));
  act(() => {
    workbench.spaces.select("dev");
    workbench.spaces.update("dev", (state) => ({
      ...state,
      namespaces: ["payments", "auth"],
    }));
    workbench.editors.open("k8s-list://dev/v1/pods");
  });
  await settle(30);
  expect(screen.getByText("No pods in dev · payments, auth")).toBeTruthy();
  expect(
    screen.getByText("Nothing of this kind exists in these namespaces."),
  ).toBeTruthy();

  act(() => {
    workbench.editors.open("k8s-list://dev/v1/pods?q=api");
  });
  await settle(30);
  expect(
    screen.getByText("No matching pods in dev · payments, auth"),
  ).toBeTruthy();

  act(() => {
    workbench.editors.open("k8s-list://dev/v1/pods?ns=checkout");
  });
  await settle(30);
  expect(screen.getByText("No pods in dev · checkout")).toBeTruthy();

  act(() => {
    workbench.editors.open("k8s-list://dev/v1/nodes");
  });
  await settle(30);
  expect(screen.getByText("No nodes in dev")).toBeTruthy();
});

test("an empty list that leaves namespaces out speaks of the ones shown, not of where it looks", async () => {
  const workbench = await mountKube(createMockBackend("partsQueued"));
  act(() => {
    workbench.spaces.select("dev");
    workbench.spaces.update("dev", (state) => ({
      ...state,
      namespaces: ["a", "b", "c", "d", "e"],
    }));
    workbench.editors.open("k8s-list://dev/v1/pods");
  });
  await settle(30);
  expect(screen.getByText("No pods in the namespaces shown")).toBeTruthy();
  expect(
    screen.getByText(
      "The namespaces that are not ready are left out; the status bar says which.",
    ),
  ).toBeTruthy();

  act(() => {
    workbench.editors.open("k8s-list://dev/v1/pods?q=api");
  });
  await settle(30);
  expect(
    screen.getByText("No matching pods in the namespaces shown"),
  ).toBeTruthy();
});

test("an empty list of all namespaces that leaves some out speaks of the ones the person may list", async () => {
  const workbench = await mountKube(createMockBackend("rbacNamespaces"));
  act(() => {
    workbench.spaces.select("dev");
    workbench.editors.open("k8s-list://dev/v1/pods");
  });
  await settle(30);
  expect(
    screen.getByText("No pods in the 1 namespace you may list"),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "Nothing of this kind exists in them, and these credentials may not list pods in the other 11.",
    ),
  ).toBeTruthy();

  act(() => {
    workbench.editors.open("k8s-list://dev/v1/pods?q=api");
  });
  await settle(30);
  expect(
    screen.getByText("No matching pods in the 1 namespace you may list"),
  ).toBeTruthy();
});

test("a list of all namespaces that is refused says so and offers to choose namespaces, and a selection that is refused keeps its words", async () => {
  const workbench = await mountKube(createMockBackend("rbacTypedNamespaces"));
  act(() => {
    workbench.editors.open("k8s-list://prod-eu/v1/pods");
  });
  await settle(30);
  expect(
    screen.getByText("You may not list pods in every namespace at once."),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Choose namespaces" }));
  expect(workbench.quickAccess.session?.value).toBe("ns ");

  act(() => {
    workbench.quickAccess.hide();
    workbench.editors.open("k8s-list://prod-eu/v1/pods?ns=auth");
  });
  await settle(30);
  expect(screen.getByText("You may not watch pods.")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Choose namespaces" }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();

  act(() => {
    workbench.editors.open("k8s-list://prod-eu/v1/nodes");
  });
  await settle(30);
  expect(screen.getByText("You may not watch nodes.")).toBeTruthy();
});

test.each([
  ["unauthorized", "Sign-in needed"],
  ["error", "Could not load pods"],
] as const)("%s shows its own panel with a retry", async (scenario, title) => {
  const backend = createMockBackend(scenario);
  const subscribe = vi.spyOn(backend, "subscribe");
  await openList(backend);
  expect(screen.getByText(title)).toBeTruthy();
  const lists = () =>
    subscribe.mock.calls.filter(([command]) => command === "list_subscribe")
      .length;
  const opened = lists();
  await settle();
  expect(lists()).toBe(opened);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await settle();
  expect(lists()).toBe(opened + 1);
  expect(screen.getByText(title)).toBeTruthy();
});

test("a scroll during a resubscribe reaches the new subscription before it shows", async () => {
  await openList();
  fireEvent.click(within(header("Ready")).getByRole("button"));
  grid().scrollTop = 3000 * 24;
  fireEvent.scroll(grid());
  for (let i = 0; i < 10; i++) {
    await act(() => vi.advanceTimersByTimeAsync(50));
    act(() => {
      vi.advanceTimersToNextFrame();
    });
    if (header("Ready").getAttribute("aria-sort") === "ascending") break;
  }
  expect(header("Ready").getAttribute("aria-sort")).toBe("ascending");
  expect(rows().length).toBeGreaterThan(10);
  expect(
    rows().filter((row) => row.querySelector("[role=gridcell]") === null),
  ).toEqual([]);
});

test("under StrictMode the list subscribes once and shows rows", async () => {
  const backend = createMockBackend("ready");
  const subscribe = vi.spyOn(backend, "subscribe");
  const invoke = vi.spyOn(backend, "invoke");
  configure({ reactStrictMode: true });
  try {
    await openList(backend);
  } finally {
    configure({ reactStrictMode: false });
  }
  const subscribes = subscribe.mock.calls.filter(
    ([command]) => command === "list_subscribe",
  );
  const unsubscribes = invoke.mock.calls.filter(
    ([command]) => command === "list_unsubscribe",
  );
  expect(subscribes.length - unsubscribes.length).toBe(1);
  expect(screen.getAllByRole("gridcell").length).toBeGreaterThan(10);
});

test("a sort changes the view on the subscription the list has and closes nothing, and unmounting leaves none open", async () => {
  const backend = createMockBackend("ready");
  const subscribe = vi.spyOn(backend, "subscribe");
  const invoke = vi.spyOn(backend, "invoke");
  await openList(backend);
  const count = (calls: readonly (readonly unknown[])[], name: string) =>
    calls.filter(([command]) => command === name).length;
  const subscribed = count(subscribe.mock.calls, "list_subscribe");
  const closed = count(invoke.mock.calls, "list_unsubscribe");
  fireEvent.click(within(header("Ready")).getByRole("button"));
  await settle();
  expect(count(subscribe.mock.calls, "list_subscribe")).toBe(subscribed);
  expect(count(invoke.mock.calls, "list_unsubscribe")).toBe(closed);
  const views = invoke.mock.calls.flatMap(([command, request]) =>
    command === "list_set_view" ? [request as RequestOf<"list_set_view">] : [],
  );
  expect(views).toHaveLength(1);
  expect(views[0]).toMatchObject({ view: 1, sort: { column: "Ready" } });
  expect(header("Ready").getAttribute("aria-sort")).not.toBe("none");
  cleanup();
  await settle(1);
  expect(count(invoke.mock.calls, "list_unsubscribe")).toBe(
    count(subscribe.mock.calls, "list_subscribe"),
  );
});

const IDS = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];

function batch(
  seq: number,
  restarts: Record<string, string>,
  first = false,
): ListBatch {
  return {
    seq,
    view: 0,
    total: IDS.length,
    columns: first
      ? [
          { name: "Name", kind: "string", priority: 0 },
          {
            name: "Restarts",
            kind: "string",
            priority: 0,
            printsDuration: true,
          },
        ]
      : null,
    window: first ? { start: 0, ids: IDS } : null,
    upserts: Object.entries(restarts).map(([id, value]) => ({
      id,
      created: null,
      received: "2026-11-16T12:00:00.000Z",
      generated: null,
      cells: [id, value],
    })),
    status: { state: "ready" },
    counts: null,
    groups: null,
    metrics: null,
  };
}

test("a changed cell flashes through the next batch, and a storm flashes nothing", async () => {
  const script = scriptedBackend();
  await openList(script.backend);
  const restarts = (id: string) =>
    cellOf(
      screen.getByText(id).closest<HTMLElement>("[role=row]") ?? undefined,
      "Restarts",
    )?.firstElementChild;
  const send = async (b: ListBatch) => {
    act(() => {
      script.send(b);
    });
    await settle(1);
  };

  await send(batch(1, Object.fromEntries(IDS.map((id) => [id, "0"])), true));
  expect(restarts("a")?.className).not.toContain("animate-flash");

  await send(batch(2, { a: "1" }));
  const flashing = restarts("a");
  expect(flashing?.className).toContain("animate-flash");

  await send(batch(3, {}));
  expect(restarts("a")).toBe(flashing);
  expect(restarts("a")?.className).toContain("animate-flash");

  await send(batch(4, Object.fromEntries(IDS.slice(1).map((id) => [id, "2"]))));
  expect(
    IDS.slice(1).filter((id) =>
      restarts(id)?.className.includes("animate-flash"),
    ),
  ).toEqual([]);
});

test("a batch draws the rows whose cells it changed, and the one whose flash ended, and no other", async () => {
  const script = scriptedBackend();
  await openList(script.backend);
  const send = async (b: ListBatch) => {
    gridRenders.rows = [];
    act(() => {
      script.send(b);
    });
    await settle(1);
    return [...new Set(gridRenders.rows)];
  };

  expect(
    await send(batch(1, Object.fromEntries(IDS.map((id) => [id, "0"])), true)),
  ).toEqual(IDS);
  expect(await send(batch(2, { a: "1", c: "1" }))).toEqual(["a", "c"]);
  expect(await send(batch(3, {}))).toEqual([]);
  await act(() => vi.advanceTimersByTimeAsync(1100));
  expect(await send(batch(4, {}))).toEqual(["a", "c"]);
  expect(await send(batch(5, {}))).toEqual([]);
});

test("a scroll that keeps rows in the window draws none of them again", async () => {
  await openList();
  const before = new Set(gridRenders.rows);
  expect(before.size).toBeGreaterThan(20);
  gridRenders.rows = [];
  grid().scrollTop = 3 * 24;
  fireEvent.scroll(grid());
  await settle(3);
  const after = new Set(gridRenders.rows);
  expect(after.size).toBeGreaterThan(0);
  expect([...after].filter((id) => before.has(id))).toEqual([]);
});

test("seconds passing render the ages and not the grid", async () => {
  const script = scriptedBackend();
  await openList(script.backend);
  act(() => {
    script.send({
      ...batch(1, {}, true),
      total: 1,
      columns: [
        { name: "Name", kind: "string", priority: 0 },
        { name: "Age", kind: "age", priority: 0 },
      ],
      window: { start: 0, ids: ["a"] },
      upserts: [
        {
          id: "a",
          created: new Date(Date.now() - 5000).toISOString(),
          received: "2026-11-16T12:00:00.000Z",
          generated: null,
          cells: ["a", null],
        },
      ],
    });
  });
  await settle(1);
  const age = () =>
    textOf(
      screen.getByText("a").closest<HTMLElement>("[role=row]") ?? undefined,
      "Age",
    );
  const before = age();
  const renders = gridRenders.count;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(age()).not.toBe(before);
  expect(gridRenders.count).toBe(renders);
});

test("a restart's age and the end of its warning come in its cell, not in the grid", async () => {
  const script = scriptedBackend();
  await openList(script.backend);
  act(() => {
    script.send({
      ...batch(1, {}, true),
      total: 1,
      columns: [
        { name: "Name", kind: "string", priority: 0 },
        { name: "Status", kind: "string", priority: 0 },
        {
          name: "Restarts",
          kind: "string",
          priority: 0,
          printsDuration: true,
        },
      ],
      window: { start: 0, ids: ["a"] },
      upserts: [
        {
          id: "a",
          created: null,
          received: new Date().toISOString(),
          generated: null,
          cells: ["a", "Running", "3 (59m ago)"],
        },
      ],
    });
  });
  await settle(1);
  const cell = () =>
    screen
      .getByText("a")
      .closest<HTMLElement>("[role=row]")
      ?.querySelector<HTMLElement>('[data-column="Restarts"]');
  expect(cell()?.textContent).toBe("359m ago");
  expect(cell()?.querySelector(".text-warn-foreground")).toBeInstanceOf(
    Element,
  );
  const renders = gridRenders.count;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(61_000);
  });
  expect(cell()?.textContent).toBe("360m ago");
  expect(cell()?.querySelector(".text-warn-foreground")).toBeNull();
  expect(gridRenders.count).toBe(renders);
});

test("the name takes the free width until an edge's drag sizes it, and the kind keeps the width", async () => {
  const backend = createMockBackend("ready");
  await openList(backend);
  expect(template()).toBe(
    "28px minmax(160px, 1fr) 120px 56px 168px 132px 72px 80px 64px 32px",
  );
  const edge = screen.getByRole("separator", { name: "Resize Name" });
  fireEvent.pointerDown(edge, { clientX: 300, pointerId: 1 });
  fireEvent.pointerMove(edge, { clientX: 400, pointerId: 1 });
  fireEvent.pointerUp(edge, { pointerId: 1 });
  expect(template()).toBe(
    "28px 260px 120px 56px 168px 132px 72px 80px 64px minmax(0px, 1fr) 32px",
  );
  fireEvent.pointerDown(edge, { clientX: 400, pointerId: 1 });
  fireEvent.pointerMove(edge, { clientX: -1000, pointerId: 1 });
  fireEvent.pointerUp(edge, { pointerId: 1 });
  expect(template().startsWith("28px 48px ")).toBe(true);
  await settle(1);

  cleanup();
  await openList(backend);
  expect(template().startsWith("28px 48px ")).toBe(true);
});

const GRID_WIDTH_AT_1280_WITH_EXPLORER = 972;

test.each([
  ["the pods of every namespace", "prod-eu", "k8s-list://prod-eu/v1/pods"],
  [
    "the pods of one namespace",
    "prod-eu",
    "k8s-list://prod-eu/v1/pods?ns=auth",
  ],
  ["the nodes", "staging", "k8s-list://staging/v1/nodes"],
])(
  "%s need no horizontal scroll at 1280 px with the explorer open, Age whole",
  async (_, space, uri) => {
    const workbench = await mountKube(createMockBackend("ready"));
    act(() => {
      workbench.spaces.select(space);
    });
    await settle();
    act(() => {
      workbench.editors.open(uri);
    });
    await settle();
    for (const name of ["CPU", "Memory", "Age"]) {
      expect(header(name)).toBeTruthy();
    }
    expect(
      Number.parseInt(screen.getAllByRole("row")[0]?.style.minWidth ?? "", 10),
    ).toBeLessThanOrEqual(GRID_WIDTH_AT_1280_WITH_EXPLORER);
  },
);

const PODS_PRESET = "list//pods";

const shownAt = (width: number) => {
  layout.resize(grid(), width);
  return screen
    .getAllByRole("columnheader")
    .map((h) => h.firstElementChild?.textContent ?? h.textContent);
};

test("a list gives up columns as it narrows and takes back the same ones in the same order as it widens, and the person's choices stay as they were", async () => {
  const backend = createMockBackend("ready");
  const choices = JSON.stringify({
    columns: { Restarts: false, Node: true },
    widths: { Name: 200 },
  });
  const set = backend.invoke("state_set", [
    { space: null, key: PODS_PRESET, value: choices },
  ]);
  await act(() => vi.advanceTimersByTimeAsync(50));
  await set;
  const workbench = await openList(backend);
  const stored = async () => {
    await act(() => workbench.state.settled());
    const loaded = backend.invoke("state_load", null);
    await act(() => vi.advanceTimersByTimeAsync(50));
    return (await loaded).app[PODS_PRESET];
  };
  expect(await stored()).toBe(choices);
  const widths = [1100, 900, 608, 465, 300];
  const narrowing = widths.map(shownAt);
  expect(narrowing).toEqual([
    [
      ...["", "Name", "Namespace", "Ready", "Status"],
      ...["CPU", "Memory", "Age", "Node", "", ""],
    ],
    [
      "",
      "Name",
      "Namespace",
      "Ready",
      "Status",
      "CPU",
      "Memory",
      "Age",
      "",
      "",
    ],
    ["", "Name", "Namespace", "Ready", "Status", "", ""],
    ["", "Name", "Status", "", ""],
    ["", "Name", "", ""],
  ]);
  expect(await stored()).toBe(choices);
  const widening = [...widths].reverse().map(shownAt).reverse();
  expect(widening).toEqual(narrowing);
  expect(await stored()).toBe(choices);
});

test("the last column to give way is Status, and Ready joins it first", async () => {
  await openList(
    createMockBackend("ready"),
    "k8s-list://prod-eu/v1/pods?q=CrashLoopBackOff",
  );
  expect(textOf(rows()[0], "Status")).toBe("CrashLoopBackOff");
  expect(shownAt(420)).toEqual(["", "Name", "Status", ""]);
  const merged = textOf(rows()[0], "Status");
  expect(merged).toMatch(/^\d+\/\d+ ?CrashLoopBackOff$/);
  expect(merged.startsWith("0/")).toBe(true);
  expect(shownAt(300)).toEqual(["", "Name", ""]);
});

const trackOf = (name: string) => {
  const tracks = template().match(/minmax\([^)]*\)|\S+/g) ?? [];
  const at = screen
    .getAllByRole("columnheader")
    .findIndex((each) => each.textContent === name);
  return tracks[at];
};

test("Status keeps the room that Ready's value takes when the person sized it, and what the person's drag keeps is the width without that room, never below a column's minimum", async () => {
  await openList(
    createMockBackend("ready"),
    "k8s-list://prod-eu/v1/pods?q=CrashLoopBackOff",
  );
  const drag = async (by: number) => {
    const edge = screen.getByRole("separator", { name: "Resize Status" });
    fireEvent.pointerDown(edge, { clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 300 + by, pointerId: 1 });
    fireEvent.pointerUp(edge, { pointerId: 1 });
    await settle(1);
  };
  await drag(40);
  expect(trackOf("Status")).toBe("208px");
  shownAt(470);
  expect(trackOf("Status")).toBe("232px");
  await drag(10);
  expect(trackOf("Status")).toBe("242px");
  shownAt(1280);
  expect(trackOf("Status")).toBe("218px");

  shownAt(470);
  await drag(-1000);
  expect(trackOf("Ready")).toBe("56px");
  expect(trackOf("Status")).toBe("48px");
  shownAt(1280);
  expect(trackOf("Status")).toBe("48px");
});

test("a sort by a column the width has dropped stays, and the Name header says so until the column is back", async () => {
  await openList();
  fireEvent.click(within(header("Memory")).getByRole("button"));
  await settle();
  const sorted = () => rows().map((row) => textOf(row, "Name"));
  const order = sorted();
  expect(header("Memory").getAttribute("aria-sort")).toBe("descending");
  expect(screen.queryByText(/^Sorted by /)).toBeNull();

  expect(shownAt(600)).toEqual(["", "Name", "Ready", "Status", "Restarts", ""]);
  await settle();
  expect(sorted()).toEqual(order);
  expect(
    screen.getByText(
      "Sorted by Memory, descending: the column has no room at this width.",
    ),
  ).toBeTruthy();

  layout.resize(grid(), 1280);
  await settle();
  expect(header("Memory").getAttribute("aria-sort")).toBe("descending");
  expect(sorted()).toEqual(order);
  expect(screen.queryByText(/^Sorted by /)).toBeNull();
});

test("a width change renders the grid once, for every row at once, and the same width renders nothing", async () => {
  await openList();
  const renders = gridRenders.count;
  layout.resize(grid(), 900);
  expect(gridRenders.count).toBe(renders + 1);
  layout.resize(grid(), 900);
  expect(gridRenders.count).toBe(renders + 1);
});

test.each([
  ["every namespace", "k8s-list://prod-eu/v1/pods", true],
  ["one namespace", "k8s-list://prod-eu/v1/pods?ns=auth", false],
])(
  "Namespace is a column of a list of %s only when it says more",
  async (_, uri, has) => {
    await openList(createMockBackend("ready"), uri);
    expect(
      screen
        .getAllByRole("columnheader")
        .some((h) => h.textContent === "Namespace"),
    ).toBe(has);
  },
);

test("a double click on a header's edge fits the column to its widest text or its title, narrowing it too", async () => {
  const measured = (element: Element) => element.textContent.length * 10;
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      return this.hasAttribute("data-fit") ||
        this.hasAttribute("data-fit-header")
        ? new DOMRect(0, 0, measured(this), 10)
        : Element.prototype.getBoundingClientRect.call(this);
    },
  });
  try {
    await openList();
    const edge = screen.getByRole("separator", { name: "Resize Name" });
    fireEvent.pointerDown(edge, { clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 700, pointerId: 1 });
    fireEvent.pointerUp(edge, { pointerId: 1 });
    expect(template().startsWith("28px 560px ")).toBe(true);
    const name = Math.max(
      ...rows().map((row) => textOf(row, "Name").length * 10 + 16),
    );
    expect(name).toBeLessThan(560);
    fireEvent.doubleClick(edge);
    await settle(1);
    expect(template()).toBe(
      `28px ${String(name)}px 120px 56px 168px 132px 72px 80px 64px minmax(0px, 1fr) 32px`,
    );

    const ready = Math.max(
      ...rows().map((row) => textOf(row, "Ready").length * 10 + 16),
    );
    expect(ready).toBeLessThan("Ready".length * 10 + 32);
    fireEvent.doubleClick(
      screen.getByRole("separator", { name: "Resize Ready" }),
    );
    await settle(1);
    expect(template()).toBe(
      `28px ${String(name)}px 120px 83px 168px 132px 72px 80px 64px minmax(0px, 1fr) 32px`,
    );
  } finally {
    Reflect.deleteProperty(HTMLElement.prototype, "getBoundingClientRect");
  }
});

test("filters that match nothing say so and offer to clear them", async () => {
  await openList(
    createMockBackend("ready"),
    "k8s-list://prod-eu/v1/pods?q=no-such-pod",
  );
  expect(screen.getByText("No matching pods in prod-eu")).toBeTruthy();
  expect(screen.queryByText("No pods in prod-eu")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  await settle();
  expect(screen.queryByText("No matching pods in prod-eu")).toBeNull();
  expect(rows().length).toBeGreaterThan(10);
  expect(screen.getByRole("textbox", { name: "Filter rows" })).toHaveProperty(
    "value",
    "",
  );
});

test("j moves on from the selected row after it scrolled out of the window", async () => {
  await openList();
  focusGrid();
  key("KeyJ");
  await settle(2);
  grid().scrollTop = 3000 * 24;
  fireEvent.scroll(grid());
  await settle();
  key("KeyJ");
  await settle();
  grid().scrollTop = 0;
  fireEvent.scroll(grid());
  await settle();
  const selected = rows().filter(
    (row) => row.getAttribute("aria-selected") === "true",
  );
  expect(selected.map((row) => row.getAttribute("aria-rowindex"))).toEqual([
    "3",
  ]);
});

test("a filter typed while j waits for its row drops the move", async () => {
  await openList();
  focusGrid();
  key("KeyJ");
  await settle(2);
  const first = textOf(rows()[0], "Name");
  grid().scrollTop = 3000 * 24;
  fireEvent.scroll(grid());
  await settle();
  key("KeyJ");
  fireEvent.change(screen.getByRole("textbox", { name: "Filter rows" }), {
    target: { value: "auth" },
  });
  await settle();
  grid().scrollTop = 0;
  fireEvent.scroll(grid());
  await settle();
  const selected = rows().filter(
    (row) => row.getAttribute("aria-selected") === "true",
  );
  expect(selected.map((row) => textOf(row, "Name"))).toEqual([first]);
});

test("j pressed after a sort is asked, before its rows arrive, is dropped with the rows it was for", async () => {
  await openList();
  focusGrid();
  key("KeyJ");
  await settle(2);
  const first = textOf(rows()[0], "Name");
  grid().scrollTop = 3000 * 24;
  fireEvent.scroll(grid());
  await settle();
  fireEvent.click(within(header("Ready")).getByRole("button"));
  key("KeyJ");
  await settle();
  grid().scrollTop = 0;
  fireEvent.scroll(grid());
  await settle();
  const selected = rows()
    .filter((row) => row.getAttribute("aria-selected") === "true")
    .map((row) => textOf(row, "Name"));
  expect(selected.filter((name) => name !== first)).toEqual([]);
});

test("a health picked while j waits for its row drops the move", async () => {
  await openList();
  focusGrid();
  key("KeyJ");
  await settle(2);
  const first = textOf(rows()[0], "Name");
  grid().scrollTop = 3000 * 24;
  fireEvent.scroll(grid());
  await settle();
  key("KeyJ");
  fireEvent.click(
    within(screen.getByRole("group", { name: "Rows by health" })).getByRole(
      "button",
      { name: /^Healthy/ },
    ),
  );
  await settle();
  grid().scrollTop = 0;
  fireEvent.scroll(grid());
  await settle();
  const selected = rows()
    .filter((row) => row.getAttribute("aria-selected") === "true")
    .map((row) => textOf(row, "Name"));
  expect(selected.filter((name) => name !== first)).toEqual([]);
});

function warnBatch(seq: number, ids: readonly string[], creating: number) {
  return {
    seq,
    total: IDS.length,
    columns: [
      { name: "Name", kind: "string", priority: 0 },
      { name: "Status", kind: "string", priority: 0 },
    ],
    window: { start: 0, ids: [...ids] },
    upserts: ids.map((id) => ({
      id,
      created: null,
      received: "2026-11-16T12:00:00.000Z",
      generated: null,
      cells: [id, "Pending"],
    })),
    status: { state: "ready" },
    counts: [
      { value: "Pending", count: IDS.length },
      ...(creating > 0
        ? [{ value: "ContainerCreating", count: creating }]
        : []),
    ],
    groups: null,
  } as ListBatch;
}

const selectedNames = () =>
  rows()
    .filter((row) => row.getAttribute("aria-selected") === "true")
    .map((row) => textOf(row, "Name"));

async function waitOnE() {
  fireEvent.click(screen.getByText("e"));
  await settle(1);
  focusGrid();
  key("KeyJ");
  await settle(1);
  expect(selectedNames()).toEqual(["e"]);
}

test("j waiting for its row lands though the picked health's values refresh meanwhile", async () => {
  const script = scriptedBackend();
  await openList(script.backend, "k8s-list://prod-eu/v1/pods?h=warn");
  act(() => {
    script.send(warnBatch(1, IDS.slice(0, 5), 1));
  });
  await settle(2);
  act(() => {
    script.send(warnBatch(1, IDS.slice(0, 5), 1));
  });
  await settle(2);
  await waitOnE();
  act(() => {
    script.send({ ...warnBatch(2, [], 0), columns: null, window: null });
  });
  await settle(2);
  act(() => {
    script.send(warnBatch(1, IDS, 0));
  });
  await settle(2);
  expect(selectedNames()).toEqual(["f"]);
});

test("j pressed while a URI's health still shows every row is dropped once its rows arrive", async () => {
  const script = scriptedBackend();
  await openList(script.backend, "k8s-list://prod-eu/v1/pods?h=warn");
  act(() => {
    script.send(warnBatch(1, IDS.slice(0, 5), 1));
  });
  await settle(2);
  await waitOnE();
  act(() => {
    script.send(warnBatch(1, IDS, 1));
  });
  await settle(2);
  expect(selectedNames().filter((name) => name !== "e")).toEqual([]);
});

test("j pressed after a health is picked, before its rows arrive, is dropped with the rows it was for", async () => {
  await openList();
  focusGrid();
  key("KeyJ");
  await settle(2);
  const first = textOf(rows()[0], "Name");
  grid().scrollTop = 3000 * 24;
  fireEvent.scroll(grid());
  await settle();
  fireEvent.click(
    within(screen.getByRole("group", { name: "Rows by health" })).getByRole(
      "button",
      { name: /^Healthy/ },
    ),
  );
  key("KeyJ");
  await settle();
  grid().scrollTop = 0;
  fireEvent.scroll(grid());
  await settle();
  expect(selectedNames().filter((name) => name !== first)).toEqual([]);
});

async function choose(column: string) {
  openMenu(screen.getByRole("button", { name: "Choose columns" }));
  fireEvent.click(screen.getByRole("menuitem", { name: column }));
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await settle(1);
}

test.each([
  ["IP", "10.244.", true],
  [undefined, "10.244.", false],
  ["Namespace", "kube-system", false],
  [undefined, "kube-system", true],
])(
  "with %s toggled the text %s matches rows: %s",
  async (column, text, matches) => {
    await openList();
    if (column) await choose(column);
    fireEvent.change(screen.getByRole("textbox", { name: "Filter rows" }), {
      target: { value: text },
    });
    await settle();
    expect(screen.queryByText("No matching pods in prod-eu") === null).toBe(
      matches,
    );
  },
);

test("the first subscription already carries the column choices the text filter follows", async () => {
  const backend = createMockBackend("ready");
  const workbench = await openList(backend);
  await choose("IP");
  const subscribe = vi.spyOn(backend, "subscribe");
  act(() => {
    workbench.editors.open("k8s-list://prod-eu/v1/pods?q=10.244.");
  });
  await settle();
  const queries = subscribe.mock.calls.flatMap(([command, request]) =>
    command === "list_subscribe" &&
    typeof request === "object" &&
    request &&
    "columns" in request
      ? [request.columns]
      : [],
  );
  expect(queries).toEqual([{ IP: true }]);
});

test("a failing row carries its tone, a name reads in its parts, and restarts read as a count and its age", async () => {
  await openList();
  const parts = (row: HTMLElement | undefined, column: string) =>
    [
      ...(cellOf(row, column)?.querySelectorAll(":scope > span span") ?? []),
    ].filter((part) => part.children.length === 0);
  const filter = async (text: string) => {
    fireEvent.change(screen.getByRole("textbox", { name: "Filter rows" }), {
      target: { value: text },
    });
    await settle();
    return rows()[0];
  };

  const running = rows().find((row) => textOf(row, "Status") === "Running");
  expect(running?.hasAttribute("data-tone")).toBe(false);
  const whole = textOf(running, "Name");
  const last = whole.lastIndexOf("-") + 1;
  const cut = whole.lastIndexOf("-", last - 2) + 1;
  const name = parts(running, "Name");
  expect(name.map((part) => part.textContent)).toEqual([
    whole.slice(0, cut),
    whole.slice(cut, last),
    whole.slice(last),
  ]);
  expect(name[1]?.textContent).toMatch(/^[0-9a-z]+-$/);
  expect(name[2]?.textContent).toMatch(/^[0-9a-z]{5}$/);

  const failing = await filter("CrashLoopBackOff");
  expect(textOf(failing, "Status")).toBe("CrashLoopBackOff");
  expect(failing?.getAttribute("data-tone")).toBe("error");
  const restarts = parts(failing, "Restarts").map((part) => part.textContent);
  expect(restarts).toHaveLength(2);
  expect(restarts[0]).toMatch(/^\d+$/);
  expect(restarts[1]).toMatch(/^(\d+[smhd])+ ago$/);

  const pending = await filter("Pending");
  expect(textOf(pending, "Status")).toBe("Pending");
  expect(pending?.getAttribute("data-tone")).toBe("warn");
});

test("a pod that is not ready and restarted within the hour warns in Ready alone, and a ready one in Restarts", async () => {
  const script = scriptedBackend();
  await openList(script.backend);
  const pod = (id: string, ready: string) => ({
    id,
    created: null,
    received: new Date().toISOString(),
    generated: null,
    cells: [id, ready, "Running", "1 (46m ago)"],
  });
  act(() => {
    script.send({
      ...batch(1, {}, true),
      total: 2,
      columns: [
        { name: "Name", kind: "string", priority: 0 },
        { name: "Ready", kind: "string", priority: 0 },
        { name: "Status", kind: "string", priority: 0 },
        {
          name: "Restarts",
          kind: "string",
          priority: 0,
          printsDuration: true,
        },
      ],
      window: { start: 0, ids: ["a", "b"] },
      upserts: [pod("a", "0/1"), pod("b", "1/1")],
    });
  });
  await settle(1);
  const warns = (id: string, column: string) =>
    cellOf(
      screen.getByText(id).closest<HTMLElement>("[role=row]") ?? undefined,
      column,
    )?.querySelector(".text-warn-foreground") instanceof Element;
  expect([warns("a", "Ready"), warns("a", "Restarts")]).toEqual([true, false]);
  expect([warns("b", "Ready"), warns("b", "Restarts")]).toEqual([false, true]);
});

const groupHeaders = () =>
  rows().filter((row) => row.hasAttribute("aria-expanded"));
const groupOf = (row: HTMLElement) =>
  [...row.querySelectorAll("[role=gridcell] > span")].map(
    (part) => part.textContent,
  );
const statusCount = (health: string) =>
  Number(
    screen
      .getByRole("button", { name: new RegExp(` ${health}$`) })
      .textContent.split(" ")[0]
      ?.replace(/,/g, ""),
  );

async function groupBy(column: string) {
  openMenu(screen.getByRole("button", { name: "Group rows" }));
  fireEvent.click(screen.getByRole("menuitem", { name: column }));
  await settle();
}

test("grouping by Namespace puts each group's rows under a header with its counts, and hides the column", async () => {
  await openList();
  await groupBy("Namespace");
  expect(screen.queryByRole("columnheader", { name: "Namespace" })).toBeNull();
  const shown = rows();
  const [first] = shown;
  expect(first && groupOf(first)[0]).toBe("auth");
  const next = shown.findIndex(
    (row, index) => index > 0 && row.hasAttribute("aria-expanded"),
  );
  const auth = shown.slice(1, next < 0 ? undefined : next);
  expect(auth.length).toBeGreaterThan(10);
  expect(
    auth.filter((row) => !textOf(row, "Name").startsWith("auth-")),
  ).toEqual([]);

  for (let open = 0; open < 12; open++) {
    const header = groupHeaders().find(
      (row) => row.getAttribute("aria-expanded") === "true",
    );
    if (!header) break;
    fireEvent.click(header);
    await settle();
  }
  const groups = groupHeaders().map(groupOf);
  expect(groups.map(([value]) => value)).toEqual([
    "auth",
    "batch",
    "checkout",
    "default",
    "ingress-nginx",
    "kube-system",
    "ledger",
    "monitoring",
    "notify",
    "payments",
    "platform",
    "search",
  ]);
  const sum = (word: string) =>
    groups.reduce((total, parts) => {
      const part = parts.find((text) => text.endsWith(` ${word}`));
      return total + Number(part?.split(" ")[0]?.replace(/,/g, "") ?? 0);
    }, 0);
  expect(sum("pods")).toBe(5000);
  expect(sum("failing")).toBe(statusCount("failing"));
  expect(sum("pending")).toBe(statusCount("pending"));
  expect(sum("failing")).toBeGreaterThan(0);
  expect(sum("pending")).toBeGreaterThan(0);
});

test("a header's click folds its group, Left goes from a row to its header, and the kind keeps the grouping", async () => {
  const backend = createMockBackend("ready");
  await openList(backend);
  await groupBy("Namespace");
  const [auth] = groupHeaders();
  if (!auth) throw new Error("no groups");
  fireEvent.click(auth);
  await settle();
  const [folded, batch, firstOfBatch, secondOfBatch] = rows();
  expect(folded && groupOf(folded)[0]).toBe("auth");
  expect(folded?.getAttribute("aria-expanded")).toBe("false");
  expect(batch && groupOf(batch)[0]).toBe("batch");
  expect(textOf(firstOfBatch, "Name").startsWith("batch-")).toBe(true);

  focusGrid();
  key("KeyJ");
  key("KeyJ");
  await settle(2);
  key("KeyJ");
  await settle(2);
  const selected = () =>
    rows().filter((row) => row.getAttribute("aria-selected") === "true");
  expect(selected().map((row) => textOf(row, "Name"))).toEqual([
    textOf(secondOfBatch, "Name"),
  ]);
  key("ArrowLeft");
  await settle(2);
  expect(selected().map((row) => groupOf(row)[0])).toEqual(["batch"]);
  key("ArrowLeft");
  await settle();
  expect(groupHeaders()[1]?.getAttribute("aria-expanded")).toBe("false");

  cleanup();
  await openList(backend);
  expect(screen.queryByRole("columnheader", { name: "Namespace" })).toBeNull();
  expect(groupHeaders().map((row) => groupOf(row)[0])[0]).toBe("auth");
  expect(
    within(screen.getByRole("button", { name: "Group rows" })).getByText(
      "Namespace",
    ),
  ).toBeTruthy();
});

test("a hovered row's verbs read that row's own state, not the selected row's", async () => {
  const script = scriptedBackend();
  const workbench = await mountKube(script.backend);
  act(() => {
    workbench.spaces.select("dev");
  });
  await settle(2);
  act(() => {
    workbench.editors.open("k8s-list://dev/v1/nodes");
  });
  await settle();
  act(() => {
    script.send({
      seq: 1,
      view: 0,
      total: 3,
      columns: [
        { name: "Name", kind: "string", priority: 0 },
        { name: "Status", kind: "string", priority: 0 },
        { name: "Version", kind: "string", priority: 0 },
      ],
      window: { start: 0, ids: ["dev/a", "dev/b", "dev/c"] },
      upserts: [
        ["dev/a", "Ready,SchedulingDisabled"],
        ["dev/b", "Ready"],
        ["dev/c", "Ready,SchedulingDisabled"],
      ].map(([id = "", status]) => ({
        id,
        created: null,
        received: "2026-11-16T12:00:00.000Z",
        generated: null,
        cells: [id.slice(4), status ?? "", "v1.37.1"],
      })),
      status: { state: "ready" },
      counts: null,
      groups: null,
      metrics: null,
    });
  });
  await settle(1);
  focusGrid();
  key("KeyJ");
  await settle(1);
  expect(selectedNames()).toEqual(["a"]);
  const icons = (name: string) => {
    const row = rows().find((each) => textOf(each, "Name") === name);
    if (!row) throw new Error(`no row ${name}`);
    fireEvent.pointerEnter(row);
    return row;
  };
  const ready = icons("b");
  await settle(2);
  expect(hoverIcons(ready)).toEqual(["Cordon", "Drain"]);
  fireEvent.pointerLeave(ready);
  const cordoned = icons("c");
  await settle(2);
  expect(hoverIcons(cordoned)).toEqual(["Uncordon", "Drain"]);
});
