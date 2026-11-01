import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import { StrictMode } from "react";
import type {
  Backend,
  GroupCount,
  ListBatch,
  ViewState,
} from "@twigo/protocol";
import { createMockBackend, type MockScenario } from "@twigo/protocol/mock";
import { PODS } from "./kinds";
import { stateLabel } from "./listStatus";
import { ResourceTable } from "./ResourceTable";

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 600,
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 1000,
  });
});

afterAll(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function settle(steps = 6) {
  for (let i = 0; i < steps; i++) {
    await act(() => vi.advanceTimersByTimeAsync(50));
    act(() => {
      vi.advanceTimersToNextFrame();
    });
  }
}

async function show(scenario: MockScenario, space = "prod-eu") {
  const onStatus =
    vi.fn<
      (total: number, status: ViewState, groups: readonly GroupCount[]) => void
    >();
  render(
    <ResourceTable
      backend={createMockBackend(scenario)}
      space={space}
      gvr={PODS}
      title="Pods"
      onStatus={onStatus}
    />,
  );
  await settle();
  return onStatus;
}

const header = (name: string) => screen.getByRole("columnheader", { name });

test("rows from the window render with the server's priority-0 columns", async () => {
  const onStatus = await show("ready");
  const [total, status, groups] = onStatus.mock.lastCall ?? [];
  expect([total, status]).toEqual([5000, { state: "ready" }]);
  expect(groups?.reduce((sum, group) => sum + group.count, 0)).toBe(5000);
  expect(groups?.[0]?.value).toBe("Running");
  const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
  expect(headers).toEqual([
    "Name",
    "Namespace",
    "Ready",
    "Status",
    "Restarts",
    "Age",
  ]);
  expect(screen.getAllByRole("row").length).toBeGreaterThan(10);
});

test("clicking a header sorts by that column, then reverses, keeping rows on screen", async () => {
  await show("ready");
  fireEvent.click(header("Ready"));
  expect(screen.getAllByRole("row").length).toBeGreaterThan(10);
  await settle();
  expect(header("Ready").getAttribute("aria-sort")).toBe("ascending");
  const cells = () =>
    screen
      .getAllByRole("row")
      .slice(1, 4)
      .map((row) => row.children[2]?.textContent);
  expect(cells()).toEqual(["0/1", "0/1", "0/1"]);
  fireEvent.click(header("Ready"));
  await settle();
  expect(header("Ready").getAttribute("aria-sort")).toBe("descending");
  expect(cells()).toEqual(["3/3", "3/3", "3/3"]);
});

test("a space without pods shows the empty state, not an error", async () => {
  await show("live", "dev");
  await settle(30);
  expect(screen.getByText("No pods")).toBeTruthy();
});

test.each([
  ["forbidden", "Access denied"],
  ["unauthorized", "Sign-in needed"],
  ["error", "Could not load pods"],
] as const)("%s shows its own panel with a retry", async (scenario, title) => {
  await show(scenario);
  expect(screen.getByText(title)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});

test.each([
  ["queued", "Waiting for a stream slot"],
  ["connecting", "Connecting…"],
  ["syncing", "Loading · 1,850"],
  ["relisting", "Relisting…"],
  ["stale", "No updates · reconnecting"],
] as const)("%s is reported and named", async (scenario, label) => {
  const onStatus = await show(scenario);
  const [, status] = onStatus.mock.lastCall ?? [];
  expect(status && stateLabel(status)).toBe(label);
});

test("a scroll during a resubscribe reaches the new subscription before it shows", async () => {
  await show("ready");
  fireEvent.click(header("Ready"));
  const grid = screen.getByRole("grid");
  grid.scrollTop = 3000 * 26;
  fireEvent.scroll(grid);
  for (let i = 0; i < 10; i++) {
    await act(() => vi.advanceTimersByTimeAsync(50));
    act(() => {
      vi.advanceTimersToNextFrame();
    });
    if (header("Ready").getAttribute("aria-sort") === "ascending") break;
  }
  expect(header("Ready").getAttribute("aria-sort")).toBe("ascending");
  const rows = screen.getAllByRole("row").slice(1);
  expect(rows.length).toBeGreaterThan(10);
  expect(
    rows.filter((row) => row.querySelector("[role=gridcell]") === null),
  ).toEqual([]);
});

test("under StrictMode the table subscribes once and shows rows", async () => {
  const backend = createMockBackend("ready");
  const subscribe = vi.spyOn(backend, "subscribe");
  const invoke = vi.spyOn(backend, "invoke");
  render(
    <StrictMode>
      <ResourceTable
        backend={backend}
        space="prod-eu"
        gvr={PODS}
        title="Pods"
      />
    </StrictMode>,
  );
  await settle();
  const unsubscribes = invoke.mock.calls.filter(
    ([command]) => command === "list_unsubscribe",
  );
  expect(subscribe.mock.calls.length - unsubscribes.length).toBe(1);
  expect(screen.getAllByRole("gridcell").length).toBeGreaterThan(10);
});

function scriptedBackend() {
  let send: ((batch: ListBatch) => void) | undefined;
  const backend: Backend = {
    invoke: () => Promise.resolve(null),
    subscribe(_command, _request, onMessage) {
      send = onMessage;
      return Promise.resolve(1);
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
      cells: [id, value],
    })),
    status: { state: "ready" },
    groups: null,
  };
}

test("a changed cell flashes through the next batch, and a storm flashes nothing", async () => {
  const script = scriptedBackend();
  render(
    <ResourceTable
      backend={script.backend}
      space="s"
      gvr={PODS}
      title="Pods"
    />,
  );
  await settle(1);
  const restarts = (id: string) =>
    screen
      .getByText(id)
      .closest("[role=row]")
      ?.querySelectorAll("[role=gridcell] > span")[1];
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

test("columns share the free width until dragging an edge sizes one", async () => {
  await show("ready");
  const row = () => screen.getAllByRole("row")[0];
  expect(
    row()?.style.gridTemplateColumns.startsWith(
      "minmax(280px, 280fr) minmax(140px, 140fr) ",
    ),
  ).toBe(true);
  const edge = screen.getByRole("separator", { name: "Resize Name" });
  fireEvent.pointerDown(edge, { clientX: 300, pointerId: 1 });
  fireEvent.pointerMove(edge, { clientX: 400, pointerId: 1 });
  fireEvent.pointerUp(edge, { pointerId: 1 });
  expect(
    row()?.style.gridTemplateColumns.startsWith("380px minmax(140px, 140fr) "),
  ).toBe(true);
  fireEvent.pointerDown(edge, { clientX: 400, pointerId: 1 });
  fireEvent.pointerMove(edge, { clientX: -1000, pointerId: 1 });
  expect(row()?.style.gridTemplateColumns.startsWith("48px ")).toBe(true);
});
