import {
  act,
  cleanup,
  configure,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Backend, ListBatch } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import {
  mountKube,
  openList,
  settle,
  withScreenSize,
} from "../../test/workbench";

withScreenSize();

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
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
    "Name",
    "Namespace",
    "Ready",
    "Status",
    "Restarts",
    "Age",
    "",
  ]);
  expect(rows().length).toBeGreaterThan(10);
});

test("clicking a header sorts by that column, then reverses, keeping rows on screen", async () => {
  await openList();
  fireEvent.click(header("Ready"));
  expect(rows().length).toBeGreaterThan(10);
  await settle();
  expect(header("Ready").getAttribute("aria-sort")).toBe("ascending");
  const cells = () =>
    rows()
      .slice(0, 3)
      .map((row) => textOf(row, "Ready"));
  expect(cells()).toEqual(["0/1", "0/1", "0/1"]);
  fireEvent.click(header("Ready"));
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
  expect(screen.getByText("No pods")).toBeTruthy();
});

test.each([
  ["forbidden", "Access denied"],
  ["unauthorized", "Sign-in needed"],
  ["error", "Could not load pods"],
] as const)("%s shows its own panel with a retry", async (scenario, title) => {
  const backend = createMockBackend(scenario);
  const subscribe = vi.spyOn(backend, "subscribe");
  await openList(backend);
  expect(screen.getByText(title)).toBeTruthy();
  const lists = () =>
    subscribe.mock.calls.filter(([command]) => command === "list_subscribe");
  expect(lists()).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await settle();
  expect(lists()).toHaveLength(2);
  expect(screen.getByText(title)).toBeTruthy();
});

test("a scroll during a resubscribe reaches the new subscription before it shows", async () => {
  await openList();
  fireEvent.click(header("Ready"));
  grid().scrollTop = 3000 * 26;
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

function scriptedBackend() {
  const mock = createMockBackend("ready");
  let send: ((batch: ListBatch) => void) | undefined;
  const backend: Backend = {
    invoke: (command, request) =>
      command.startsWith("list_")
        ? Promise.resolve(null as never)
        : mock.invoke(command, request),
    subscribe(command, request, onMessage) {
      if (command !== "list_subscribe")
        return mock.subscribe(command, request, onMessage);
      send = onMessage;
      return Promise.resolve(1 as never);
    },
  };
  return { backend, send: (batch: ListBatch) => send?.(batch) };
}

const IDS = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];

function batch(
  seq: number,
  restarts: Record<string, string>,
  first = false,
): ListBatch {
  return {
    seq,
    total: IDS.length,
    columns: first
      ? [
          { name: "Name", kind: "string", priority: 0 },
          { name: "Restarts", kind: "string", priority: 0 },
        ]
      : null,
    window: first ? { start: 0, ids: IDS } : null,
    upserts: Object.entries(restarts).map(([id, value]) => ({
      id,
      created: null,
      generated: null,
      cells: [id, value],
    })),
    status: { state: "ready" },
    counts: null,
    groups: null,
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

test("the name takes the free width until an edge's drag sizes it, and the kind keeps the width", async () => {
  const backend = createMockBackend("ready");
  await openList(backend);
  expect(template()).toBe(
    "28px minmax(280px, 1fr) 120px 56px 160px 112px 64px 32px",
  );
  const edge = screen.getByRole("separator", { name: "Resize Name" });
  fireEvent.pointerDown(edge, { clientX: 300, pointerId: 1 });
  fireEvent.pointerMove(edge, { clientX: 400, pointerId: 1 });
  fireEvent.pointerUp(edge, { pointerId: 1 });
  expect(template()).toBe(
    "28px 380px 120px 56px 160px 112px 64px minmax(0, 1fr) 32px",
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

test("a double click on a header's edge fits the column to its widest text or its title, narrowing it too", async () => {
  const measured = (element: Element) => element.textContent.length * 10;
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      return this.hasAttribute("data-fit")
        ? new DOMRect(0, 0, measured(this), 10)
        : Element.prototype.getBoundingClientRect.call(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-fit-header") ? measured(this) : 0;
    },
  });
  try {
    await openList();
    const name = Math.max(
      ...rows().map((row) => textOf(row, "Name").length * 10 + 16),
    );
    expect(name).toBeLessThan(280);
    fireEvent.doubleClick(
      screen.getByRole("separator", { name: "Resize Name" }),
    );
    await settle(1);
    expect(template()).toBe(
      `28px ${String(name)}px 120px 56px 160px 112px 64px minmax(0, 1fr) 32px`,
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
      `28px ${String(name)}px 120px 82px 160px 112px 64px minmax(0, 1fr) 32px`,
    );
  } finally {
    Reflect.deleteProperty(HTMLElement.prototype, "getBoundingClientRect");
    Reflect.deleteProperty(HTMLElement.prototype, "scrollWidth");
  }
});

test("filters that match nothing say so and offer to clear them", async () => {
  await openList(
    createMockBackend("ready"),
    "k8s-list://prod-eu/v1/pods?q=no-such-pod",
  );
  expect(screen.getByText("No matching pods")).toBeTruthy();
  expect(screen.queryByText("No pods")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  await settle();
  expect(screen.queryByText("No matching pods")).toBeNull();
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
  grid().scrollTop = 3000 * 26;
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
    expect(screen.queryByText("No matching pods") === null).toBe(matches);
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

test("a failing row has an edge, a name's generated part reads quieter, and restarts read as a count and its age", async () => {
  await openList();
  const parts = (row: HTMLElement | undefined, column: string) => [
    ...(cellOf(row, column)?.querySelectorAll(":scope > span > span > span") ??
      []),
  ];
  const filter = async (text: string) => {
    fireEvent.change(screen.getByRole("textbox", { name: "Filter rows" }), {
      target: { value: text },
    });
    await settle();
    return rows()[0];
  };

  const running = rows().find((row) => textOf(row, "Status") === "Running");
  expect(running?.className).not.toMatch(/var\(--(error|warn)\)/);
  const whole = textOf(running, "Name");
  const cut = whole.lastIndexOf("-", whole.lastIndexOf("-") - 1) + 1;
  const name = parts(running, "Name");
  expect(name.map((part) => part.textContent)).toEqual([
    whole.slice(0, cut),
    whole.slice(cut),
  ]);
  expect(name[1]?.textContent).toMatch(/^[0-9a-z]+-[0-9a-z]{5}$/);
  expect(name[0]?.className).not.toContain("text-muted-foreground");
  expect(name[1]?.className).toContain("text-muted-foreground-2");

  const failing = await filter("CrashLoopBackOff");
  expect(textOf(failing, "Status")).toBe("CrashLoopBackOff");
  expect(failing?.className).toContain("var(--error)");
  const restarts = parts(failing, "Restarts").map((part) => part.textContent);
  expect(restarts).toHaveLength(2);
  expect(restarts[0]).toMatch(/^\d+$/);
  expect(restarts[1]).toMatch(/^\d+m ago$/);

  const pending = await filter("Pending");
  expect(textOf(pending, "Status")).toBe("Pending");
  expect(pending?.className).toContain("var(--warn)");
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
