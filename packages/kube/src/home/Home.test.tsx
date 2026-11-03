import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
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
import type { Backend, ListBatch, ListQuery } from "@twigo/protocol";
import { createMockBackend, type MockScenario } from "@twigo/protocol/mock";
import { StateStore, Workbench, WorkbenchView } from "@twigo/workbench";
import { byHealth } from "../columns";
import { PODS } from "../kinds";
import { registerKube } from "../register";
import { parseListUri } from "../uri";

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

interface Subscribed {
  readonly query: ListQuery;
  readonly batches: ListBatch[];
}

function recording(scenario: MockScenario) {
  const backend = createMockBackend(scenario);
  const lists: Subscribed[] = [];
  const recorded: Backend = {
    invoke: (command, request) => backend.invoke(command, request),
    subscribe: (command, request, onMessage) => {
      if (command !== "list_subscribe")
        return backend.subscribe(command, request, onMessage);
      const list: Subscribed = { query: request as ListQuery, batches: [] };
      lists.push(list);
      return backend.subscribe(command, request, (message) => {
        list.batches.push(message as ListBatch);
        onMessage(message);
      });
    },
  };
  return { backend: recorded, lists };
}

async function home(scenario: MockScenario = "ready") {
  const { backend, lists } = recording(scenario);
  const state = StateStore.load(backend, () => undefined);
  await act(() => vi.advanceTimersByTimeAsync(10));
  const workbench = new Workbench(
    backend,
    "mac",
    { id: "us", keys: {} },
    await state,
  );
  registerKube(workbench);
  const loaded = Promise.all([
    workbench.catalog.watch(),
    workbench.spaces.load(),
  ]);
  await act(() => vi.advanceTimersByTimeAsync(10));
  await loaded;
  render(<WorkbenchView workbench={workbench} />);
  await settle();
  return { workbench, lists };
}

function latest(lists: readonly Subscribed[], resource: string) {
  const list = lists.filter((l) => l.query.gvr.resource === resource).pop();
  let total = -1;
  let counts: NonNullable<ListBatch["counts"]> = [];
  for (const batch of list?.batches ?? []) {
    total = batch.total;
    counts = batch.counts ?? counts;
  }
  return { query: list?.query, total, counts };
}

const NODES = { group: "", version: "v1", resource: "nodes" };
const DEPLOYMENTS = { group: "apps", version: "v1", resource: "deployments" };

const tile = (label: string) =>
  within(screen.getByRole("region", { name: "Counts" })).getByText(label, {
    selector: "span",
  }).parentElement;
const attention = () =>
  screen.queryByRole("region", { name: "Needs attention" });

test("the home shows the space's counts, which Rust takes without sending a row", async () => {
  const { lists } = await home();
  const nodes = latest(lists, "nodes");
  const pods = latest(lists, "pods");
  const deployments = latest(lists, "deployments");
  const events = latest(lists, "events");
  expect(nodes.query?.countBy).toBe("Status");
  expect(pods.query?.countBy).toBe("Status");
  expect(deployments.query?.countBy).toBe("Ready");
  expect(events.query?.countBy).toBe("Type");
  for (const list of lists) {
    for (const batch of list.batches) {
      expect(batch.upserts, list.query.gvr.resource).toEqual([]);
      expect(batch.window?.ids ?? [], list.query.gvr.resource).toEqual([]);
    }
  }

  const podHealth = byHealth(PODS, "Status", pods.counts);
  const notReady = byHealth(NODES, "Status", nodes.counts).error.count;
  const short = byHealth(DEPLOYMENTS, "Ready", deployments.counts).warn.count;
  const warnings =
    events.counts.find((value) => value.value === "Warning")?.count ?? 0;
  expect(
    [
      notReady,
      podHealth.error.count,
      podHealth.warn.count,
      short,
      warnings,
    ].every((n) => n > 0),
  ).toBe(true);

  expect(screen.getByRole("heading", { name: "prod-eu" })).toBeTruthy();
  expect(
    screen.getByText(`Kubernetes v1.33.4 · ${String(nodes.total)} nodes`),
  ).toBeTruthy();
  const shown = (n: number) => n.toLocaleString("en");
  expect(tile("Nodes")?.textContent).toBe(
    `Nodes${shown(nodes.total)}${shown(notReady)} not ready`,
  );
  expect(tile("Pods")?.textContent).toBe(
    `Pods${shown(pods.total)}${shown(podHealth.error.count)} failing · ${shown(podHealth.warn.count)} pending`,
  );
  expect(tile("Deployments")?.textContent).toBe(
    `Deployments${shown(deployments.total)}${shown(short)} short of ready`,
  );
  expect(tile("Warning events")?.textContent).toBe(
    `Warning events${shown(warnings)}of ${shown(events.total)} events`,
  );

  const rows = [...(attention()?.querySelectorAll("li") ?? [])].map(
    (row) => row.textContent,
  );
  const statuses = [...podHealth.error.values, ...podHealth.warn.values].sort(
    (a, b) => b.count - a.count || a.value.localeCompare(b.value),
  );
  expect(
    rows.slice(0, statuses.length).map((row) => row.split(" · ")[0]),
  ).toEqual(statuses.map((value) => value.value));
  expect(rows[0]).toContain(`· ${shown(statuses[0]?.count ?? 0)} pods`);
  expect(rows.slice(statuses.length).map((row) => row.split(" · ")[0])).toEqual(
    ["Not ready", "Short of ready"],
  );
});

test("a tile opens its list with its filter, and a Show the pods of one status", async () => {
  const { workbench } = await home();
  act(() => {
    fireEvent.click(
      within(screen.getByRole("region", { name: "Counts" })).getByRole(
        "button",
        { name: /^Pods/ },
      ),
    );
  });
  expect(workbench.editors.active).toBe("k8s-list://prod-eu/v1/pods?h=error");
  act(() => {
    workbench.editors.close(workbench.editors.active ?? "");
  });
  await settle(2);
  act(() => {
    fireEvent.click(
      within(screen.getByRole("region", { name: "Counts" })).getByRole(
        "button",
        { name: /^Deployments/ },
      ),
    );
  });
  expect(workbench.editors.active).toBe(
    "k8s-list://prod-eu/apps/v1/deployments?h=warn",
  );
  act(() => {
    workbench.editors.close(workbench.editors.active ?? "");
  });
  await settle(2);
  const [first] = screen.getAllByRole("button", { name: /^Show / });
  const status = first?.getAttribute("aria-label")?.slice("Show ".length);
  act(() => {
    if (first) fireEvent.click(first);
  });
  expect(parseListUri(workbench.editors.active ?? "x:")).toMatchObject({
    gvr: { resource: "pods" },
    text: `/^${status ?? "?"}$/`,
  });
});

test("a list the credentials may not read shows – and why, never 0", async () => {
  await home("live");
  await settle(30);
  const nodes = tile("Nodes");
  expect(nodes?.textContent).toBe(
    "Nodes–These credentials may not list nodes.",
  );
  expect(nodes?.closest("button")).toBeNull();
  expect(tile("Pods")?.textContent).toMatch(/^Pods5,000/);
  expect(screen.getByText("Kubernetes v1.33.4")).toBeTruthy();
});

test("the home leaves when an editor opens and comes back when the last closes", async () => {
  const { workbench } = await home();
  expect(attention()).not.toBeNull();
  act(() => {
    workbench.editors.open("k8s-list://prod-eu/v1/pods");
  });
  await settle(2);
  expect(attention()).toBeNull();
  act(() => {
    workbench.editors.open("k8s-list://prod-eu/apps/v1/deployments");
  });
  act(() => {
    workbench.editors.close("k8s-list://prod-eu/v1/pods");
  });
  await settle(2);
  expect(attention()).toBeNull();
  act(() => {
    workbench.editors.close("k8s-list://prod-eu/apps/v1/deployments");
  });
  await settle(2);
  expect(attention()).not.toBeNull();
});

test("the home lists the space's recent editors, each opening again", async () => {
  const { workbench } = await home();
  expect(screen.queryByRole("region", { name: "Recent" })).toBeNull();
  act(() => {
    workbench.editors.open("k8s-list://prod-eu/v1/pods");
  });
  await settle(2);
  act(() => {
    workbench.editors.close("k8s-list://prod-eu/v1/pods");
  });
  await settle(2);
  const recent = screen.getByRole("region", { name: "Recent" });
  fireEvent.click(within(recent).getByRole("button", { name: /^Pods/ }));
  await settle(2);
  expect(workbench.editors.active).toBe("k8s-list://prod-eu/v1/pods");
});
