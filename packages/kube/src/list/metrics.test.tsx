import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Backend, ListBatch, ListQuery, RequestOf } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { Changes } from "@twigo/workbench";
import { openList, settle, withScreenSize } from "../../test/workbench";

const gridRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock("@twigo/ui", async (original) => {
  const ui = await original<typeof import("@twigo/ui")>();
  return {
    ...ui,
    DataGrid: (props: Parameters<typeof ui.DataGrid>[0]) => {
      gridRenders.count++;
      return <ui.DataGrid {...props} />;
    },
  };
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const header = (name: string) => screen.getByRole("columnheader", { name });
const rows = () => screen.getAllByRole("row").slice(1);
const textOf = (row: HTMLElement | undefined, column: string) =>
  row?.querySelector(`[data-column="${column}"]`)?.textContent ?? "";
const grid = () => screen.getByRole("grid");

function spied(backend: Backend) {
  const invoke = vi.spyOn(backend, "invoke");
  const subscribe = vi.spyOn(backend, "subscribe");
  return {
    reading: () => {
      const last = new Map<number, boolean>();
      for (const [command, request] of invoke.mock.calls) {
        if (command !== "list_set_window") continue;
        const { id, metrics } = request as RequestOf<"list_set_window">;
        last.set(id, metrics);
      }
      return [...last.values()].some(Boolean);
    },
    reads: () =>
      invoke.mock.calls
        .filter(([command]) => command === "list_set_window")
        .map(
          ([, request]) => (request as RequestOf<"list_set_window">).metrics,
        ),
    subscriptions: () =>
      subscribe.mock.calls.filter(([command]) => command === "list_subscribe")
        .length,
    queries: () =>
      subscribe.mock.calls
        .filter(([command]) => command === "list_subscribe")
        .map(([, request]) => request as ListQuery),
  };
}

const last = <T,>(items: readonly T[]) => items[items.length - 1];

function scripted() {
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
  return {
    backend,
    send: async (batch: ListBatch) => {
      act(() => {
        send?.(batch);
      });
      await settle(1);
    },
  };
}

async function choose(column: string) {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Choose columns" }),
    {
      button: 0,
      ctrlKey: false,
    },
  );
  fireEvent.click(screen.getByRole("menuitem", { name: column }));
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await settle(1);
}

async function sortBy(column: string) {
  fireEvent.click(within(header(column)).getByRole("button"));
  await settle();
}

describe("the main list", () => {
  withScreenSize(1000);

  test("shows CPU and Memory by default as kubectl prints them, and a dash for a pod without a sample", async () => {
    await openList();
    expect(
      screen.getAllByRole("columnheader").map((h) => h.textContent),
    ).toContain("CPU");
    const running = rows().filter((row) => textOf(row, "Status") === "Running");
    expect(running.length).toBeGreaterThan(0);
    for (const row of running) {
      expect(textOf(row, "CPU")).toMatch(/^\d+m$/);
      expect(textOf(row, "Memory")).toMatch(/^\d+Mi$/);
    }
    fireEvent.change(screen.getByRole("textbox", { name: "Filter rows" }), {
      target: { value: "Pending" },
    });
    await settle();
    expect(rows().length).toBeGreaterThan(0);
    for (const row of rows()) {
      expect(textOf(row, "Status")).toBe("Pending");
      expect(textOf(row, "CPU")).toBe("–");
      expect(textOf(row, "Memory")).toBe("–");
    }
  });

  async function throughASort(
    scenario: "ready" | "metricsForbidden",
    each: (cpu: Map<string, string>) => void,
  ) {
    await openList(createMockBackend(scenario));
    fireEvent.change(screen.getByRole("textbox", { name: "Filter rows" }), {
      target: { value: "auth-api" },
    });
    await settle(30);
    const before = new Map(
      rows().map((row) => [textOf(row, "Name"), textOf(row, "CPU")]),
    );
    fireEvent.click(within(header("Status")).getByRole("button"));
    for (let step = 0; step < 20; step++) {
      await act(() => vi.advanceTimersByTimeAsync(10));
      act(() => {
        vi.advanceTimersToNextFrame();
      });
      each(before);
    }
    expect(header("Status").getAttribute("aria-sort")).toBe("ascending");
  }

  test("a change of sort never shows a dash in a row that had a value", async () => {
    await throughASort("ready", (had) => {
      expect([...had.values()].some((cpu) => cpu !== "–")).toBe(true);
      for (const row of rows()) {
        if ((had.get(textOf(row, "Name")) ?? "–") !== "–")
          expect(textOf(row, "CPU")).not.toBe("–");
      }
    });
  });

  test("a change of sort keeps the header's mark when the context refuses metrics", async () => {
    await throughASort("metricsForbidden", () => {
      expect(header("CPU").getAttribute("aria-describedby")).not.toBeNull();
    });
  });

  test("reads while a metric column is drawn, and a toggle says so at once without another subscription", async () => {
    const backend = createMockBackend("ready");
    const sent = spied(backend);
    await openList(backend);
    const subscriptions = sent.subscriptions();
    expect(last(sent.reads())).toBe(true);
    await choose("CPU");
    expect(last(sent.reads())).toBe(true);
    await choose("Memory");
    expect(last(sent.reads())).toBe(false);
    expect(screen.queryByRole("columnheader", { name: "CPU" })).toBeNull();
    await choose("CPU");
    expect(last(sent.reads())).toBe(true);
    expect(sent.subscriptions()).toBe(subscriptions);
  });

  test("with a text filter set, showing or hiding CPU or Memory opens no subscription, though another column does", async () => {
    const backend = createMockBackend("ready");
    const sent = spied(backend);
    await openList(backend);
    fireEvent.change(screen.getByRole("textbox", { name: "Filter rows" }), {
      target: { value: "auth" },
    });
    await settle(30);
    const subscriptions = sent.subscriptions();
    await choose("CPU");
    await choose("Memory");
    await choose("CPU");
    expect(last(sent.reads())).toBe(true);
    expect(sent.subscriptions()).toBe(subscriptions);
    await choose("Restarts");
    expect(sent.subscriptions()).toBe(subscriptions + 1);
  });

  test("reads while the list is sorted by a metric though none is drawn, and stops with the sort", async () => {
    const backend = createMockBackend("ready");
    const sent = spied(backend);
    await openList(backend);
    await sortBy("CPU");
    await choose("CPU");
    await choose("Memory");
    expect(screen.queryByRole("columnheader", { name: "CPU" })).toBeNull();
    expect(last(sent.reads())).toBe(true);
    await sortBy("Name");
    expect(last(sent.reads())).toBe(false);
  });

  test("a first click on CPU or Memory sorts the largest first and the next ascends, while Name ascends first", async () => {
    await openList();
    const direction = (column: string) =>
      header(column).getAttribute("aria-sort");
    const measured = (column: string) =>
      rows()
        .map((row) => textOf(row, column))
        .filter((text) => text !== "–")
        .map((text) => Number.parseInt(text, 10));
    const descending = (values: number[]) =>
      values.every((value, at) => at === 0 || (values[at - 1] ?? 0) >= value);
    for (const column of ["CPU", "Memory"]) {
      await sortBy(column);
      expect(direction(column)).toBe("descending");
      const largest = measured(column);
      expect(largest.length).toBeGreaterThan(1);
      expect(descending(largest)).toBe(true);
      await sortBy(column);
      expect(direction(column)).toBe("ascending");
      const smallest = measured(column);
      expect(descending([...smallest].reverse())).toBe(true);
      expect(smallest).not.toEqual(largest);
    }
    await sortBy("Name");
    expect(direction("Name")).toBe("ascending");
  });

  test("a hidden document reads nothing, and showing it reads at once", async () => {
    const backend = createMockBackend("ready");
    const sent = spied(backend);
    await openList(backend);
    expect(last(sent.reads())).toBe(true);
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(last(sent.reads())).toBe(false);
    hidden.mockReturnValue(false);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(last(sent.reads())).toBe(true);
  });

  test("a list behind another tab reads nothing, and reads again once shown", async () => {
    const backend = createMockBackend("ready");
    const sent = spied(backend);
    const workbench = await openList(backend);
    expect(sent.reading()).toBe(true);
    act(() => {
      workbench.editors.open("k8s-list://prod-eu/apps/v1/deployments");
    });
    await settle();
    expect(sent.reading()).toBe(false);
    act(() => {
      workbench.editors.open("k8s-list://prod-eu/v1/pods");
    });
    await settle();
    expect(sent.reading()).toBe(true);
  });

  test("a list that goes behind another tab and returns keeps the header's mark when the context refuses metrics", async () => {
    const backend = createMockBackend("metricsForbidden");
    const sent = spied(backend);
    const workbench = await openList(backend);
    await settle(30);
    expect(header("CPU").getAttribute("aria-describedby")).not.toBeNull();
    act(() => {
      workbench.editors.open("k8s-list://prod-eu/apps/v1/deployments");
    });
    await settle();
    expect(sent.reading()).toBe(false);
    act(() => {
      workbench.editors.open("k8s-list://prod-eu/v1/pods");
    });
    for (let step = 0; step < 20; step++) {
      await act(() => vi.advanceTimersByTimeAsync(10));
      act(() => {
        vi.advanceTimersToNextFrame();
      });
      expect(sent.reading()).toBe(true);
      expect(header("CPU").getAttribute("aria-describedby")).not.toBeNull();
      expect(rows().length).toBeGreaterThan(0);
    }
  });

  test("a list under a maximized panel reads nothing, and reads again once the panel gives way", async () => {
    const backend = createMockBackend("ready");
    const sent = spied(backend);
    const workbench = await openList(backend);
    const space = workbench.spaces.active?.id ?? "";
    expect(sent.reading()).toBe(true);
    act(() => {
      workbench.spaces.setPart(space, "panel", {
        visible: true,
        maximized: true,
      });
    });
    await settle();
    expect(sent.reading()).toBe(false);
    act(() => {
      workbench.spaces.setPart(space, "panel", { maximized: false });
    });
    await settle();
    expect(sent.reading()).toBe(true);
  });

  test("beside the details the list draws no metric column and reads nothing, sorted by one or not", async () => {
    const backend = createMockBackend("ready");
    const sent = spied(backend);
    await openList(backend);
    await sortBy("CPU");
    expect(last(sent.reads())).toBe(true);
    fireEvent.click(rows()[0] ?? document.body);
    await settle();
    expect(screen.queryByRole("columnheader", { name: "CPU" })).toBeNull();
    expect(last(sent.reads())).toBe(false);
    fireEvent.click(
      within(
        screen.getByRole("complementary", { name: "Pod details" }),
      ).getByRole("button", { name: "Close details" }),
    );
    await settle();
    expect(last(sent.reads())).toBe(true);
  });

  test("a context without the Metrics API has no metric columns and reads nothing", async () => {
    const backend = createMockBackend("metricsNone");
    const sent = spied(backend);
    await openList(backend);
    await settle(30);
    expect(
      screen.getAllByRole("columnheader").map((h) => h.textContent),
    ).not.toContain("CPU");
    expect(last(sent.reads())).toBe(false);
  });

  test("a list loses its metric columns when the context stops serving the API, and stays a list that reads nothing", async () => {
    const backend = createMockBackend("metricsRemoved");
    const sent = spied(backend);
    await openList(backend);
    await settle(30);
    fireEvent.click(within(header("CPU")).getByRole("button"));
    await settle(10);
    expect(header("CPU").getAttribute("aria-sort")).toBe("descending");
    expect(last(sent.reads())).toBe(true);

    await act(() => vi.advanceTimersByTimeAsync(20_000));
    await settle(10);
    expect(
      screen.getAllByRole("columnheader").map((h) => h.textContent),
    ).not.toContain("CPU");
    expect(header("Name")).toBeTruthy();
    expect(rows().length).toBeGreaterThan(0);
    expect(last(sent.reads())).toBe(false);
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });

  test.each([
    ["metricsDown", /metrics-server does not answer/],
    ["metricsForbidden", /may not read metrics/],
  ] as const)(
    "%s keeps the columns with dashes for cells and says why in their headers' marks, with no error",
    async (scenario, why) => {
      await openList(createMockBackend(scenario));
      await settle(30);
      expect(header("CPU").getAttribute("aria-describedby")).not.toBeNull();
      for (const name of ["CPU", "Memory"]) {
        expect(header(name).textContent).toMatch(why);
      }
      expect(header("Status").textContent).toBe("Status");
      expect(rows().length).toBeGreaterThan(0);
      for (const row of rows()) {
        expect(textOf(row, "CPU")).toBe("–");
        expect(textOf(row, "Memory")).toBe("–");
      }
      expect(screen.queryByText(/Could not load/)).toBeNull();
      expect(document.querySelector("[data-sonner-toast]")).toBeNull();
    },
  );
});

describe("a poll", () => {
  withScreenSize(1000);

  const IDS = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];

  function poll(
    seq: number,
    cpu: Record<string, number | null>,
    restarts: Record<string, string> = {},
    metrics: ListBatch["metrics"] = "ready",
  ): ListBatch {
    const first = seq === 1;
    return {
      seq,
      total: IDS.length,
      columns: first
        ? [
            { name: "Name", kind: "string", priority: 0 },
            { name: "Restarts", kind: "string", priority: 0 },
            { name: "CPU", kind: "cpu", priority: 0 },
            { name: "Memory", kind: "memory", priority: 0 },
          ]
        : null,
      window: first ? { start: 0, ids: IDS } : null,
      upserts: Object.entries(cpu).map(([id, nanocores]) => ({
        id,
        created: null,
        generated: null,
        cells: [id, restarts[id] ?? "0", nanocores, 64 * 1024 * 1024],
      })),
      status: { state: "ready" },
      counts: null,
      groups: null,
      metrics,
    };
  }

  const everyRow = (nanocores: number | null) =>
    Object.fromEntries(IDS.map((id) => [id, nanocores]));

  const rowOf = (id: string) =>
    rows().find((candidate) => textOf(candidate, "Name") === id);
  const flashing = (id: string, column: string) =>
    rowOf(id)
      ?.querySelector(`[data-column="${column}"] span`)
      ?.className.includes("animate-flash");

  test("that moves some measures renders the grid once, flashes nothing, and leaves the selection and the status alone", async () => {
    const script = scripted();
    await openList(script.backend);
    await script.send(poll(1, everyRow(10_000_000)));
    expect(textOf(rowOf("a"), "CPU")).toBe("10m");
    act(() => {
      grid().focus();
    });
    fireEvent.keyDown(grid(), { code: "KeyJ", key: "j" });
    await settle(1);
    expect(
      rows().filter((row) => row.getAttribute("aria-selected") === "true"),
    ).toHaveLength(1);
    const emits = vi.spyOn(Changes.prototype, "emit");
    const renders = gridRenders.count;
    await script.send(poll(2, { a: 12_000_000, b: 12_000_000, c: 12_000_000 }));
    expect(textOf(rowOf("a"), "CPU")).toBe("12m");
    expect(textOf(rowOf("e"), "CPU")).toBe("10m");
    expect(gridRenders.count).toBe(renders + 1);
    expect(emits).not.toHaveBeenCalled();
    expect(document.querySelectorAll(".animate-flash")).toHaveLength(0);
  });

  test("a first batch with the columns and no state shows no mark and dashes, and the state after it adds the mark", async () => {
    const script = scripted();
    await openList(script.backend);
    await script.send(poll(1, everyRow(null), {}, null));
    expect(header("CPU").getAttribute("aria-describedby")).toBeNull();
    expect(header("CPU").textContent).toBe("CPU");
    expect(header("Memory").getAttribute("aria-describedby")).toBeNull();
    expect(textOf(rowOf("a"), "CPU")).toBe("–");
    await script.send(poll(2, {}, {}, "forbidden"));
    expect(header("CPU").getAttribute("aria-describedby")).not.toBeNull();
    expect(header("CPU").textContent).toMatch(/may not read metrics/);
    expect(textOf(rowOf("a"), "CPU")).toBe("–");
  });

  test("that moves every row's measures does not stop a restart's flash", async () => {
    const script = scripted();
    await openList(script.backend);
    await script.send(poll(1, everyRow(10_000_000)));
    await script.send(poll(2, everyRow(20_000_000), { a: "1" }));
    expect(flashing("a", "Restarts")).toBe(true);
    expect(textOf(rowOf("j"), "CPU")).toBe("20m");
    expect(flashing("j", "CPU")).toBe(false);
  });
});

describe("a column named like a measure", () => {
  withScreenSize(1000);

  const POOLS = "k8s-list://prod-eu/kwok.x-k8s.io/v1alpha1/stages";

  function pools(): ListBatch {
    return {
      seq: 1,
      total: 2,
      columns: [
        { name: "Name", kind: "string", priority: 0 },
        { name: "CPU", kind: "string", priority: 1 },
        { name: "Memory", kind: "string", priority: 1 },
      ],
      window: { start: 0, ids: ["a", "b"] },
      upserts: [
        ["a", "16", "64Gi"],
        ["b", "8", "32Gi"],
      ].map((cells) => ({
        id: cells[0] ?? "",
        created: null,
        generated: null,
        cells,
      })),
      status: { state: "ready" },
      counts: null,
      groups: null,
      metrics: null,
    };
  }

  test("of a custom resource is an ordinary column: shown, filtered and sorted as one, and it reads nothing", async () => {
    const script = scripted();
    const sent = spied(script.backend);
    await openList(script.backend, POOLS);
    await script.send(pools());
    expect(screen.queryByRole("columnheader", { name: "CPU" })).toBeNull();
    await choose("CPU");
    expect(textOf(rows()[0], "CPU")).toBe("16");
    fireEvent.change(screen.getByRole("textbox", { name: "Filter rows" }), {
      target: { value: "16" },
    });
    await settle(30);
    expect(last(sent.queries())?.columns).toEqual({ CPU: true });
    await script.send(pools());
    await sortBy("CPU");
    expect(last(sent.queries())?.sort).toEqual({
      column: "CPU",
      descending: false,
    });
    expect(sent.reads()).not.toContain(true);
  });

  test("is left out of a pod list's text filter only once the list's columns say it is a measure", async () => {
    const backend = createMockBackend("ready");
    const sent = spied(backend);
    const workbench = await openList(backend);
    await choose("CPU");
    act(() => {
      workbench.editors.open("k8s-list://prod-eu/v1/pods?q=auth");
    });
    await settle(30);
    expect(
      sent
        .queries()
        .filter((query) => query.text === "auth")
        .map((query) => query.columns),
    ).toEqual([{ CPU: false }, null]);
  });
});
