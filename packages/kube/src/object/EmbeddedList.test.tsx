import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  Backend,
  EmbeddedList as Spec,
  ListBatch,
  ObjectRef,
  RequestOf,
  ViewState,
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

const PANICKED: ViewState = {
  state: "error",
  error: {
    code: "internal.panic",
    kind: "internal",
    message: "Twigo stopped this list on an internal error",
  },
};

/** A backend whose first subscription of a list ends in `status`. */
function endingOnce(status: ViewState) {
  const mock = createMockBackend("ready");
  const backend = {
    subscribed: 0,
    invoke: (command, request) => mock.invoke(command, request),
    subscribe: (command, request, onMessage) => {
      if (command !== "list_subscribe") {
        return mock.subscribe(command, request, onMessage);
      }
      const ended = ++backend.subscribed === 1;
      return mock.subscribe(command, request, (batch) => {
        const list = batch as ListBatch;
        onMessage(ended ? { ...list, status } : list);
      });
    },
  } satisfies Backend & { subscribed: number };
  return backend;
}

test("a list that Twigo stopped offers Reopen beside Report…, and Reopen subscribes it anew", async () => {
  const backend = endingOnce(PANICKED);
  await shown(NODE_PODS, vi.fn(), new OverviewStates(), backend);
  await settle(12);
  expect(screen.getByText("This view stopped.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Report…" })).toBeTruthy();
  expect(screen.queryByRole("grid")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
  await settle(12);
  expect(backend.subscribed).toBe(2);
  expect(screen.getByRole("grid")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
});

test("a list the server refuses offers no Reopen", async () => {
  const backend = endingOnce({
    state: "forbidden",
    verb: "list",
    resource: "pods",
  });
  await shown(NODE_PODS, vi.fn(), new OverviewStates(), backend);
  await settle(12);
  expect(screen.getByText("server.forbidden")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
});
