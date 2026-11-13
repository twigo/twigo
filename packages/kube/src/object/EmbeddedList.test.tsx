import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  Backend,
  EmbeddedList as Spec,
  ObjectRef,
  RequestOf,
} from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { EditorShownContext } from "@twigo/workbench";
import { inWorkbench, testWorkbench } from "@twigo/workbench/testing";
import { settle, withScreenSize } from "../../test/workbench";
import { EmbeddedList } from "./EmbeddedList";
import { OverviewStates } from "./overviewStates";

withScreenSize();

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
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
  expect(screen.getByText("No pods")).toBeDefined();
  expect(screen.queryByRole("grid")).toBeNull();
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
