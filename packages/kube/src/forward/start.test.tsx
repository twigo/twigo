import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createMockBackend,
  FAILS_AFTER_MS,
  READY_AFTER_MS,
  type MockScenario,
} from "@twigo/protocol/mock";
import type { Workbench } from "@twigo/workbench";
import { openList, settle, withScreenSize } from "../../test/workbench";
import { pfUri } from "../uri";

withScreenSize(1400);

const SERVICES = { group: "", version: "v1", resource: "services" };
const PODS = { group: "", version: "v1", resource: "pods" };
const GATEWAY = {
  space: "prod-eu",
  gvr: SERVICES,
  namespace: "payments",
  name: "payments-gateway",
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  for (const dismiss of document.querySelectorAll<HTMLElement>(
    '[data-sonner-toast] button[aria-label="Dismiss"]',
  )) {
    dismiss.click();
  }
  history.replaceState(null, "", "/");
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** The pods of prod-eu in a list, with every request to the backend recorded. */
async function listed(scenario: MockScenario = "live", variant = "") {
  if (variant) history.replaceState(null, "", `/?variant=${variant}`);
  const backend = createMockBackend(scenario);
  const invoke = vi.spyOn(backend, "invoke");
  const workbench = await openList(backend);
  await act(() => vi.advanceTimersByTimeAsync(1500));
  await settle(4);
  return {
    workbench,
    backend,
    calls: (command: string): unknown[] =>
      invoke.mock.calls
        .filter(([name]) => name === command)
        .map(([, request]) => request),
  };
}

const grid = () => screen.getByRole("grid");
const press = (code: string, init: KeyboardEventInit = {}) => {
  fireEvent.keyDown(grid(), { code, key: code, ...init });
};
const rows = () => screen.getAllByRole("row").slice(1);
const row = (n: number): HTMLElement => {
  const found = rows()[n];
  if (!found) throw new Error(`no row ${String(n)}`);
  return found;
};
const nameOf = (row: HTMLElement | undefined) =>
  row?.querySelector('[data-column="Name"]')?.textContent ?? "";

/** Selects the first row by the keyboard and returns its pod's name. */
async function selectFirst(): Promise<string> {
  act(() => {
    grid().focus();
  });
  press("ArrowDown", { key: "ArrowDown" });
  await settle(4);
  return nameOf(rows()[0]);
}

const letter = (key: string, init: KeyboardEventInit = {}) => {
  press(`Key${key.toUpperCase()}`, { key, ...init });
};

const live = () =>
  [
    ...document.querySelectorAll<HTMLElement>(
      '[data-sonner-toast][data-removed="false"]',
    ),
  ].map((toast) => toast.textContent);

const toastButton = (name: string) => {
  const toast = document.querySelector<HTMLElement>(
    '[data-sonner-toast][data-removed="false"]',
  );
  if (!toast) throw new Error("no toast");
  return within(toast).getByRole("button", { name });
};

/** Runs the object-level command on the Service of three ports. */
function forwardGateway(
  workbench: Workbench,
  more: Record<string, unknown> = {},
) {
  return workbench.commands.execute(
    "k8s.forward.open",
    workbench.keys.lookup(null),
    { ...GATEWAY, ...more },
  );
}

async function pick(workbench: Workbench, id?: string) {
  const asking = workbench.quickAccess.session?.pick;
  if (!asking) throw new Error("nothing asks");
  act(() => {
    asking.resolve(asking.items.find((item) => item.id === id));
  });
  await settle(6);
}

const labels = (workbench: Workbench) =>
  workbench.quickAccess.session?.pick?.items.map(
    ({ label, description }) => [label, description] as const,
  );

test("f on a pod with one port starts it at once and opens its tab", async () => {
  const { workbench, calls } = await listed();
  const name = await selectFirst();
  letter("f");
  await settle(10);
  const [asked] = calls("forward_ports");
  expect(asked).toMatchObject({ space: "prod-eu", gvr: PODS, name });
  expect(workbench.quickAccess.session).toBeUndefined();
  expect(calls("forward_start")).toEqual([
    { target: asked, port: 8080, local: null },
  ]);
  await settle(6);
  expect(workbench.editors.active).toBe(pfUri({ space: "prod-eu", id: 1 }));
});

test("f on a Service with several ports asks which, the default first, each line saying its local port", async () => {
  const { workbench, calls } = await listed();
  const run = forwardGateway(workbench);
  await settle(6);
  expect(labels(workbench)).toEqual([
    ["http 80 → localhost:8080", "default"],
    ["metrics 9090 → localhost:9090", undefined],
    ["grpc 9000 → localhost:9000", undefined],
  ]);
  await pick(workbench, "9090");
  await run;
  expect(calls("forward_start")).toEqual([
    { target: GATEWAY, port: 9090, local: null },
  ]);
  expect(workbench.editors.active).toBe(pfUri({ space: "prod-eu", id: 1 }));
});

test("a pick that is dismissed starts nothing", async () => {
  const { workbench, calls } = await listed();
  const run = forwardGateway(workbench);
  await settle(6);
  await pick(workbench);
  await run;
  expect(calls("forward_start")).toEqual([]);
  expect(workbench.editors.active).not.toMatch(/^pf:/);
});

test("a port that is forwarded already goes to its forward, never to a second", async () => {
  const { workbench, calls } = await listed();
  const first = forwardGateway(workbench);
  await settle(6);
  await pick(workbench, "80");
  await first;
  await act(() => vi.advanceTimersByTimeAsync(READY_AFTER_MS + 100));
  act(() => {
    workbench.editors.close(pfUri({ space: "prod-eu", id: 1 }));
  });
  await settle(4);

  const again = forwardGateway(workbench);
  await settle(6);
  const forwarded = workbench.quickAccess.session?.pick?.items[0];
  expect(forwarded?.state).toEqual({ label: "Ready", tone: "ok" });
  await pick(workbench, "80");
  await again;
  expect(calls("forward_start")).toHaveLength(1);
  expect(workbench.editors.active).toBe(pfUri({ space: "prod-eu", id: 1 }));
});

test("f on a pod whose port is forwarded goes to that forward without a pick or a start", async () => {
  const { workbench, calls } = await listed();
  await selectFirst();
  letter("f");
  await settle(10);
  act(() => {
    workbench.editors.close(pfUri({ space: "prod-eu", id: 1 }));
  });
  await settle(4);
  act(() => {
    grid().focus();
  });
  letter("f");
  await settle(10);
  expect(calls("forward_start")).toHaveLength(1);
  expect(workbench.quickAccess.session).toBeUndefined();
  expect(workbench.editors.active).toBe(pfUri({ space: "prod-eu", id: 1 }));
});

test("⇧F asks which port even where the pod has one", async () => {
  const { workbench, calls } = await listed();
  await selectFirst();
  letter("f", { shiftKey: true });
  await settle(10);
  expect(labels(workbench)).toEqual([
    ["http 8080 → localhost:8080", "default · app"],
  ]);
  await pick(workbench, "8080");
  expect(calls("forward_start")).toHaveLength(1);
});

test.each([
  ["pods", "k8s-list://prod-eu/v1/pods", true],
  ["deployments", "k8s-list://prod-eu/apps/v1/deployments", true],
  ["jobs", "k8s-list://prod-eu/batch/v1/jobs", false],
  ["events", "k8s-list://prod-eu/v1/events", false],
])(
  "f on the %s list is offered as its kind says, in the row's menu and on the key",
  async (_kind, uri, forwardable) => {
    const backend = createMockBackend("live");
    const invoke = vi.spyOn(backend, "invoke");
    await openList(backend, uri);
    await act(() => vi.advanceTimersByTimeAsync(1500));
    await settle(4);
    act(() => {
      grid().focus();
    });
    press("ArrowDown", { key: "ArrowDown" });
    await settle(4);
    fireEvent.contextMenu(row(0));
    await settle(4);
    const items = within(screen.getByRole("menu"))
      .getAllByRole("menuitem")
      .map((item) => item.querySelector("span")?.textContent);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await settle(4);
    letter("f");
    await settle(6);
    expect(items.includes("Forward")).toBe(forwardable);
    expect(items.includes("Forward Port…")).toBe(forwardable);
    expect(invoke.mock.calls.some(([name]) => name === "forward_ports")).toBe(
      forwardable,
    );
  },
);

test("a workload that declares no port says so in words, and nothing starts", async () => {
  const { workbench, calls } = await listed();
  const run = workbench.commands.execute(
    "k8s.forward.open",
    workbench.keys.lookup(null),
    {
      space: "prod-eu",
      gvr: { group: "apps", version: "v1", resource: "statefulsets" },
      namespace: "payments",
      name: "db",
    },
  );
  await settle(8);
  await run;
  expect(live().join("\n")).toContain(
    "StatefulSet db declares no TCP port to forward",
  );
  expect(calls("forward_start")).toEqual([]);
});

test("the object editors of a Service and a workload offer Forward in their title, and others do not", async () => {
  const { workbench } = await listed();
  const titleHas = async (uri: string) => {
    act(() => {
      workbench.editors.open(uri);
    });
    await settle(8);
    return screen.queryByRole("button", { name: "Forward" }) !== null;
  };
  expect(
    await titleHas("k8s://prod-eu//v1/services/payments/payments-gateway"),
  ).toBe(true);
  expect(
    await titleHas("k8s://prod-eu/apps/v1/deployments/payments/payments-api"),
  ).toBe(true);
  expect(await titleHas("k8s://prod-eu//v1/configmaps/payments/settings")).toBe(
    false,
  );
  expect(await titleHas("k8s://prod-eu//v1/nodes/prod-eu-node-1")).toBe(false);
});

test("Forward in an object editor's title starts the object's port", async () => {
  const { workbench, calls } = await listed();
  act(() => {
    workbench.editors.open(
      "k8s://prod-eu/apps/v1/deployments/payments/payments-api",
    );
  });
  await settle(8);
  fireEvent.click(screen.getByRole("button", { name: "Forward" }));
  await settle(10);
  expect(calls("forward_start")).toEqual([
    {
      target: {
        space: "prod-eu",
        gvr: { group: "apps", version: "v1", resource: "deployments" },
        namespace: "payments",
        name: "payments-api",
      },
      port: 8080,
      local: null,
    },
  ]);
});

test("with start:once f starts the default port at once and says so, with Change… to pick another", async () => {
  const { workbench, calls } = await listed("live", "start:once");
  const run = forwardGateway(workbench);
  await settle(8);
  await run;
  expect(workbench.quickAccess.session).toBeUndefined();
  expect(calls("forward_start")).toEqual([
    { target: GATEWAY, port: 80, local: null },
  ]);
  expect(live()).toEqual([
    "Forwarding localhost:8080 → payments-gateway:httpChange…",
  ]);

  fireEvent.click(toastButton("Change…"));
  await settle(8);
  expect(labels(workbench)).toEqual([
    ["http 80 → localhost:8080", "default"],
    ["metrics 9090 → localhost:9090", undefined],
    ["grpc 9000 → localhost:9000", undefined],
  ]);
  await pick(workbench, "9090");
  expect(calls("forward_start")).toHaveLength(2);
});

test("with start:once a pod's only port has no Change…, and ⇧F still asks", async () => {
  const { workbench, calls } = await listed("live", "start:once");
  await selectFirst();
  letter("f");
  await settle(10);
  expect(live()).toHaveLength(1);
  expect(live()[0]).toMatch(/^Forwarding localhost:8080 → \S+:http$/);
  expect(calls("forward_start")).toHaveLength(1);
  act(() => {
    workbench.editors.close(pfUri({ space: "prod-eu", id: 1 }));
  });
  await settle(4);
  act(() => {
    grid().focus();
  });
  letter("f", { shiftKey: true });
  await settle(8);
  expect(workbench.quickAccess.session?.pick).toBeDefined();
});

test("with open:list no tab opens: the side bar shows Port forwards with the new row selected", async () => {
  const { workbench } = await listed("live", "open:list");
  const run = forwardGateway(workbench);
  await settle(6);
  await pick(workbench, "9090");
  await run;
  await act(() => vi.advanceTimersByTimeAsync(READY_AFTER_MS + 100));
  expect(workbench.editors.active).not.toMatch(/^pf:/);
  expect(
    screen.getByRole("tab", { name: "Port forwards", selected: true }),
  ).toBeTruthy();
  const row = within(screen.getByRole("grid", { name: "Port forwards" }))
    .getAllByRole("row")
    .slice(1)[0];
  expect(row?.getAttribute("aria-selected")).toBe("true");
  expect(row?.textContent).toContain("metrics 9090 → 9090");
});

test("with open:list a port already forwarded selects its row", async () => {
  const { workbench } = await listed("live", "open:list");
  const first = forwardGateway(workbench);
  await settle(6);
  await pick(workbench, "80");
  await first;
  fireEvent.click(screen.getByRole("tab", { name: "Explorer" }));
  await settle(4);
  const again = forwardGateway(workbench);
  await settle(6);
  await pick(workbench, "80");
  await again;
  expect(
    screen.getByRole("tab", { name: "Port forwards", selected: true }),
  ).toBeTruthy();
});

test("a local port that is in use is not replaced: the toast offers the next, and a click takes it", async () => {
  const { workbench, calls } = await listed("forwardBusy");
  const run = forwardGateway(workbench);
  await settle(6);
  await pick(workbench, "80");
  await run;
  await settle(6);
  expect(live()).toEqual([
    "8080 is in use by another process or forward, so payments-gateway:http is not forwarded.Use 8081",
  ]);
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(calls("forward_start")).toEqual([
    { target: GATEWAY, port: 80, local: null },
  ]);
  expect(workbench.editors.active).not.toMatch(/^pf:/);

  fireEvent.click(toastButton("Use 8081"));
  await settle(8);
  expect(calls("forward_start")).toEqual([
    { target: GATEWAY, port: 80, local: null },
    { target: GATEWAY, port: 80, local: 8081 },
  ]);
  expect(workbench.editors.active).toBe(pfUri({ space: "prod-eu", id: 1 }));
});

test("with busy:input the free port is asked for, filled in, with why", async () => {
  const { workbench, calls } = await listed("forwardBusy", "busy:input");
  const run = forwardGateway(workbench);
  await settle(6);
  await pick(workbench, "80");
  await settle(6);
  const ask = workbench.quickAccess.session?.ask;
  expect(ask?.prompt).toBe(
    "8080 is in use by another process or forward. Forward payments-gateway:http on",
  );
  expect(ask?.value).toBe("8081");
  expect(live()).toEqual([]);
  expect(calls("forward_start")).toHaveLength(1);
  act(() => {
    workbench.quickAccess.submit();
  });
  await settle(8);
  await run;
  expect(calls("forward_start")).toEqual([
    { target: GATEWAY, port: 80, local: null },
    { target: GATEWAY, port: 80, local: 8081 },
  ]);
});

test("a start that fails opens its tab and says the target's own failure", async () => {
  const { workbench } = await listed("forwardFailed");
  const run = forwardGateway(workbench);
  await settle(6);
  await pick(workbench, "80");
  await run;
  await act(() => vi.advanceTimersByTimeAsync(FAILS_AFTER_MS + 100));
  expect(workbench.editors.active).toBe(pfUri({ space: "prod-eu", id: 1 }));
  expect(live()[0]).toMatch(
    /^payments-gateway:http → 8080 failed: pod \S+ refused the connection to port 8080: nothing listens on it/,
  );
});
