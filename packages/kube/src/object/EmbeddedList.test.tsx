import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  Backend,
  EmbeddedList as Spec,
  ListBatch,
  ObjectRef,
  RequestOf,
} from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { EditorShownContext } from "@twigo/workbench";
import { inWorkbench, testWorkbench } from "@twigo/workbench/testing";
import { settle, withScreenSize } from "../../test/workbench";
import { EmbeddedList } from "./EmbeddedList";
import { OverviewStates } from "./overviewStates";

const layout = withScreenSize(1000);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const NODE_PODS: Spec = {
  gvr: { group: "", version: "v1", resource: "pods" },
  kind: "Pod",
  namespaced: true,
  namespace: null,
  fieldSelector: "spec.nodeName=prod-eu-node-0",
  owners: null,
};

async function shown(
  list: Spec,
  onOpen: (target: ObjectRef) => void,
  states = new OverviewStates(),
  backend?: Backend,
  editorShown = true,
) {
  const pending = testWorkbench("ready", backend);
  await vi.advanceTimersByTimeAsync(10);
  const workbench = await pending;
  render(
    <EmbeddedList
      list={list}
      space="prod-eu"
      states={states}
      kind="/nodes"
      id="core.pods"
      onOpen={onOpen}
    />,
    {
      wrapper: ({ children }) => {
        const Workbench = inWorkbench(workbench);
        return (
          <Workbench>
            <EditorShownContext.Provider value={editorShown}>
              {children}
            </EditorShownContext.Provider>
          </Workbench>
        );
      },
    },
  );
  await settle();
  return workbench;
}

function rows(): HTMLElement[] {
  return within(screen.getByRole("grid")).getAllByRole("row").slice(1);
}

test("a node's pods come counted by status, and a row opens its pod", async () => {
  const onOpen = vi.fn();
  await shown(NODE_PODS, onOpen);
  const first = rows()[0];
  expect(first).toBeDefined();
  expect(document.body.textContent).toMatch(/\d+ Running/);
  act(() => {
    first?.click();
  });
  const name = first?.textContent ?? "";
  expect(onOpen).toHaveBeenCalledOnce();
  const target = onOpen.mock.calls[0]?.[0] as ObjectRef;
  expect(target).toMatchObject({ group: "", version: "v1", kind: "Pod" });
  expect(target.namespace).not.toBeNull();
  expect(name).toContain(target.name);
});

test("the keys of lists move along its rows and open one", async () => {
  const onOpen = vi.fn();
  const workbench = await shown(NODE_PODS, onOpen);
  const grid = screen.getByRole("grid");
  act(() => {
    grid.focus();
  });
  const lookup = workbench.keys.lookup(grid);
  await act(async () => {
    await workbench.commands.execute("list.focusDown", lookup);
  });
  await act(async () => {
    await workbench.commands.execute("list.select", lookup);
  });
  expect(onOpen).toHaveBeenCalledOnce();
});

test("owners that control nothing list no pods", async () => {
  await shown({ ...NODE_PODS, fieldSelector: null, owners: [] }, vi.fn());
  expect(screen.getByText("No pods in prod-eu")).toBeDefined();
  expect(screen.queryByRole("grid")).toBeNull();
});

test("an empty list of an object's namespace names the context before the namespace", async () => {
  await shown(
    { ...NODE_PODS, namespace: "payments", fieldSelector: null, owners: [] },
    vi.fn(),
  );
  expect(screen.getByText("No pods in prod-eu · payments")).toBeDefined();
});

test("a sort is kept for the kind's next object", async () => {
  const states = new OverviewStates();
  await shown(NODE_PODS, vi.fn(), states);
  act(() => {
    within(screen.getByRole("columnheader", { name: "Name" }))
      .getByRole("button")
      .click();
  });
  expect(states.sort("/nodes", "core.pods")).toMatchObject({ column: "Name" });
});

test("a first click on CPU sorts its list descending, as in the main list", async () => {
  const states = new OverviewStates();
  await shown(NODE_PODS, vi.fn(), states);
  act(() => {
    within(screen.getByRole("columnheader", { name: "CPU" }))
      .getByRole("button")
      .click();
  });
  expect(states.sort("/nodes", "core.pods")).toEqual({
    column: "CPU",
    descending: true,
  });
});

function reads(invoke: { mock: { calls: unknown[][] } }): boolean | undefined {
  const sent = invoke.mock.calls
    .filter(([command]) => command === "list_set_window")
    .map(([, request]) => (request as RequestOf<"list_set_window">).metrics);
  return sent[sent.length - 1];
}

test("a node's pods show CPU and Memory and read them while the document is visible", async () => {
  const backend = createMockBackend("ready");
  const invoke = vi.spyOn(backend, "invoke");
  await shown(NODE_PODS, vi.fn(), new OverviewStates(), backend);
  expect(
    screen.getAllByRole("columnheader").map((header) => header.textContent),
  ).toEqual(expect.arrayContaining(["CPU", "Memory"]));
  expect(reads(invoke)).toBe(true);
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(reads(invoke)).toBe(false);
  hidden.mockRestore();
});

function windows(invoke: { mock: { calls: unknown[][] } }): boolean[] {
  return invoke.mock.calls
    .filter(([command]) => command === "list_set_window")
    .map(([, request]) => (request as RequestOf<"list_set_window">).metrics)
    .filter((metrics, at, all) => at === 0 || metrics !== all[at - 1]);
}

function measuredLate(width: number, after: number) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly report: ResizeObserverCallback) {}
      observe(target: Element) {
        setTimeout(() => {
          this.report(
            [
              {
                target,
                contentRect: new DOMRectReadOnly(0, 0, width, 600),
              } as ResizeObserverEntry,
            ],
            this,
          );
        }, after);
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    },
  );
}

test.each([
  ["wide", 1000],
  ["narrow", 400],
])(
  "a node's pods sorted by CPU say they read from their first window, before their width is known, and a %s one goes on reading",
  async (_, width) => {
    measuredLate(width, 500);
    const backend = createMockBackend("ready");
    const invoke = vi.spyOn(backend, "invoke");
    const states = new OverviewStates();
    states.setSort("/nodes", "core.pods", { column: "CPU", descending: true });
    await shown(NODE_PODS, vi.fn(), states, backend);
    expect(windows(invoke)).toEqual([true]);
    await act(() => vi.advanceTimersByTimeAsync(600));
    expect(windows(invoke)).toEqual([true]);
  },
);

test("a node's pods sorted by a column that has no metric stop reading once their width leaves no CPU or Memory", async () => {
  measuredLate(400, 500);
  const backend = createMockBackend("ready");
  const invoke = vi.spyOn(backend, "invoke");
  const states = new OverviewStates();
  states.setSort("/nodes", "core.pods", { column: "Name", descending: false });
  await shown(NODE_PODS, vi.fn(), states, backend);
  expect(windows(invoke)).toEqual([true]);
  await act(() => vi.advanceTimersByTimeAsync(600));
  expect(windows(invoke)).toEqual([true, false]);
});

test("a node's pods read nothing while their editor is not shown", async () => {
  const backend = createMockBackend("ready");
  const invoke = vi.spyOn(backend, "invoke");
  await shown(NODE_PODS, vi.fn(), new OverviewStates(), backend, false);
  expect(reads(invoke)).toBe(false);
});

test("a Metrics API that does not answer is said in the header's mark", async () => {
  await shown(
    NODE_PODS,
    vi.fn(),
    new OverviewStates(),
    createMockBackend("metricsDown"),
  );
  await settle(30);
  expect(screen.getByRole("columnheader", { name: "CPU" }).textContent).toMatch(
    /metrics-server does not answer/,
  );
});

test("a node's pod that is not ready and restarted within the hour warns in Ready alone, and a ready one in Restarts", async () => {
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
  await shown(NODE_PODS, vi.fn(), new OverviewStates(), backend);
  const pod = (id: string, ready: string) => ({
    id,
    created: null,
    received: new Date().toISOString(),
    generated: null,
    cells: [id, ready, "Running", "1 (46m ago)"],
  });
  act(() => {
    send?.({
      seq: 1,
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
      status: { state: "ready" },
      counts: null,
      groups: null,
      metrics: null,
    });
  });
  await settle(1);
  const warns = (id: string, column: string) =>
    screen
      .getByText(id)
      .closest("[role=row]")
      ?.querySelector(
        `[data-column="${column}"] .text-warn-foreground`,
      ) instanceof Element;
  expect([warns("a", "Ready"), warns("a", "Restarts")]).toEqual([true, false]);
  expect([warns("b", "Ready"), warns("b", "Restarts")]).toEqual([false, true]);
});

function listWrapper(): HTMLElement {
  const wrapper = screen.getByRole("grid").parentElement?.parentElement;
  if (!wrapper) throw new Error("the list's wrapper");
  return wrapper;
}

function drawnAt(width: number): string[] {
  layout.resize(listWrapper(), width);
  return screen
    .getAllByRole("columnheader")
    .map(
      (header) => header.firstElementChild?.textContent ?? header.textContent,
    )
    .filter((title) => title !== "");
}

const WIDTHS = [1100, 900, 800, 700, 600, 500, 400, 300];

test("a node's pods give up columns in the list's order as the width falls, Ready into Status, and the name last, and take them back as it grows", async () => {
  await shown(NODE_PODS, vi.fn());
  const falling = WIDTHS.map(drawnAt);
  expect(falling).toEqual([
    [
      "Name",
      "Namespace",
      "Ready",
      "Status",
      "Restarts",
      "CPU",
      "Memory",
      "Age",
    ],
    [
      "Name",
      "Namespace",
      "Ready",
      "Status",
      "Restarts",
      "CPU",
      "Memory",
      "Age",
    ],
    ["Name", "Namespace", "Ready", "Status", "Restarts", "Age"],
    ["Name", "Namespace", "Ready", "Status", "Restarts"],
    ["Name", "Ready", "Status", "Restarts"],
    ["Name", "Ready", "Status"],
    ["Name", "Status"],
    ["Name"],
  ]);
  const rising = [...WIDTHS].reverse().map(drawnAt).reverse();
  expect(rising).toEqual(falling);
});

test("a node's pods read their CPU and Memory only while a column of them is drawn", async () => {
  const backend = createMockBackend("ready");
  const invoke = vi.spyOn(backend, "invoke");
  await shown(NODE_PODS, vi.fn(), new OverviewStates(), backend);
  expect(reads(invoke)).toBe(true);
  drawnAt(700);
  expect(reads(invoke)).toBe(false);
  drawnAt(1000);
  expect(reads(invoke)).toBe(true);
});

test("a list sorted by a column that has left says so in the name's header", async () => {
  const states = new OverviewStates();
  states.setSort("/nodes", "core.pods", { column: "CPU", descending: true });
  await shown(NODE_PODS, vi.fn(), states);
  drawnAt(700);
  expect(
    screen.getByRole("columnheader", { name: "Name" }).textContent,
  ).toMatch(/Sorted by CPU, descending: the column has no room at this width/);
});

type Pod = readonly [name: string, status: string];

const idOf = (name: string) => `prod-eu/payments/${name}`;

function scripted(pods: readonly Pod[]) {
  const mock = createMockBackend("ready");
  const rows = [...pods];
  const asked: (readonly [number, number])[] = [];
  let send: ((batch: ListBatch) => void) | undefined;
  let wanted: readonly [number, number] | undefined;
  let held = new Set<string>();
  let seq = 0;
  const answer = () => {
    if (!send || !wanted) return;
    const shown = rows.slice(...wanted);
    const fresh = shown.filter(([name]) => !held.has(idOf(name)));
    held = new Set(shown.map(([name]) => idOf(name)));
    send({
      seq: ++seq,
      total: rows.length,
      columns: [
        { name: "Name", kind: "string", priority: 0 },
        { name: "Status", kind: "string", priority: 0 },
      ],
      window: { start: wanted[0], ids: shown.map(([name]) => idOf(name)) },
      upserts: fresh.map(([name, status]) => ({
        id: idOf(name),
        created: null,
        received: "2026-11-16T12:00:00.000Z",
        generated: null,
        cells: [name, status],
      })),
      status: { state: "ready" },
      counts: null,
      groups: null,
      metrics: null,
    });
  };
  const backend: Backend = {
    invoke(command, request) {
      if (command === "list_set_window") {
        const { start, end } = request as RequestOf<"list_set_window">;
        asked.push([start, end]);
        wanted = [start, end];
        setTimeout(answer, 0);
      }
      return command.startsWith("list_")
        ? Promise.resolve(null as never)
        : mock.invoke(command, request);
    },
    subscribe(command, request, onMessage) {
      if (command !== "list_subscribe")
        return mock.subscribe(command, request, onMessage);
      send = onMessage;
      held = new Set();
      return Promise.resolve(1 as never);
    },
  };
  return {
    backend,
    asked,
    add(pod: Pod) {
      rows.push(pod);
      answer();
    },
  };
}

function fleet(count: number, others: Record<number, string>): Pod[] {
  return Array.from({ length: count }, (_, at) => [
    `web-${String(at).padStart(3, "0")}`,
    others[at] ?? "Running",
  ]);
}

const names = () =>
  rows().map((row) => row.querySelector('[data-column="Name"]')?.textContent);

const DEPLOYMENT_PODS: Spec = {
  ...NODE_PODS,
  fieldSelector: null,
  owners: ["uid-1"],
};

test("a Deployment's pods list the failing first, then the pending, then the rest, each as the core sent them", async () => {
  await shown(
    DEPLOYMENT_PODS,
    vi.fn(),
    new OverviewStates(),
    scripted([
      ["web-a", "Running"],
      ["web-b", "Pending"],
      ["web-c", "Running"],
      ["web-d", "CrashLoopBackOff"],
    ]).backend,
  );
  expect(names()).toEqual(["web-d", "web-b", "web-a", "web-c"]);
});

test("a list the person sorted keeps the order they chose", async () => {
  const states = new OverviewStates();
  states.setSort("/nodes", "core.pods", { column: "Name", descending: false });
  await shown(
    DEPLOYMENT_PODS,
    vi.fn(),
    states,
    scripted([
      ["web-a", "Running"],
      ["web-b", "Pending"],
      ["web-c", "Running"],
      ["web-d", "CrashLoopBackOff"],
    ]).backend,
  );
  expect(names()).toEqual(["web-a", "web-b", "web-c", "web-d"]);
});

test("a Deployment's pods up to 100 come whole, the failing then the pending then the rest, each as the core sent them", async () => {
  const script = scripted(
    fleet(100, {
      80: "Pending",
      90: "CrashLoopBackOff",
      95: "CrashLoopBackOff",
    }),
  );
  await shown(DEPLOYMENT_PODS, vi.fn(), new OverviewStates(), script.backend);
  expect(names().slice(0, 5)).toEqual([
    "web-090",
    "web-095",
    "web-080",
    "web-000",
    "web-001",
  ]);
  expect(script.asked[script.asked.length - 1]).toEqual([0, 100]);
});

test("more than 100 pods stay in the core's order, and the list asks for the window it shows", async () => {
  const script = scripted(
    fleet(101, { 10: "CrashLoopBackOff", 100: "CrashLoopBackOff" }),
  );
  await shown(DEPLOYMENT_PODS, vi.fn(), new OverviewStates(), script.backend);
  expect(names().slice(0, 3)).toEqual(["web-000", "web-001", "web-002"]);
  expect(names().indexOf("web-010")).toBe(10);
  expect(script.asked[script.asked.length - 1]?.[1]).toBeLessThan(101);
});

test("a list that opens draws no frame in the core's order, since its first window holds the whole list", async () => {
  const frames: (string | null)[][] = [];
  const watch = new MutationObserver(() => {
    frames.push(
      [...document.querySelectorAll('[role="gridcell"]')]
        .filter((cell) => cell.getAttribute("data-column") === "Name")
        .map((cell) => cell.textContent),
    );
  });
  watch.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  const script = scripted(fleet(52, { 50: "Pending", 51: "CrashLoopBackOff" }));
  await shown(DEPLOYMENT_PODS, vi.fn(), new OverviewStates(), script.backend);
  watch.disconnect();
  const drawn = frames.filter((names) => names.length > 0);
  expect(drawn.length).toBeGreaterThan(0);
  expect(drawn.map(([first]) => first)).toEqual(drawn.map(() => "web-051"));
});
test("a list that grows from 52 to 53 pods draws no frame in the core's order", async () => {
  const script = scripted(fleet(52, { 50: "Pending", 51: "CrashLoopBackOff" }));
  await shown(DEPLOYMENT_PODS, vi.fn(), new OverviewStates(), script.backend);
  const first = ["web-051", "web-050", "web-000"];
  expect(names().slice(0, 3)).toEqual(first);
  act(() => {
    script.add(["web-052", "Running"]);
  });
  expect(names().slice(0, 3)).toEqual(first);
  await settle(2);
  expect(names().slice(0, 3)).toEqual(first);
  expect(script.asked.every(([start, end]) => start === 0 && end === 100)).toBe(
    true,
  );
});
