import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { IpcError, type Backend, type Blocked } from "@twigo/protocol";
import {
  BLOCKED_AFTER_MS,
  createMockBackend,
  FAILS_AFTER_MS,
  READY_AFTER_MS,
  type MockScenario,
} from "@twigo/protocol/mock";
import type { Workbench } from "@twigo/workbench";
import { confirmAsking } from "@twigo/workbench/testing";
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
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** The pods of prod-eu in a list, with every request to the backend recorded. */
async function listed(scenario: MockScenario = "live") {
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

test("f on a pod with one port asks which, and its pick starts the forward and opens its tab", async () => {
  const { workbench, calls } = await listed();
  const name = await selectFirst();
  letter("f");
  await settle(10);
  const [asked] = calls("forward_ports");
  expect(asked).toMatchObject({ space: "prod-eu", gvr: PODS, name });
  expect(labels(workbench)).toEqual([
    ["http 8080 → localhost:8080", "default · app"],
  ]);
  expect(calls("forward_start")).toEqual([]);
  await pick(workbench, "8080");
  expect(calls("forward_start")).toEqual([
    { target: asked, port: 8080, local: null },
  ]);
  await settle(6);
  expect(workbench.editors.active).toBe(pfUri({ space: "prod-eu", id: 1 }));
  expect(live()).toEqual([]);
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
  expect(live()).toEqual([]);
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

test("f on a pod whose port is forwarded asks, shows it forwarded, and its pick goes to that forward, never a second", async () => {
  const { workbench, calls } = await listed();
  await selectFirst();
  letter("f");
  await settle(10);
  await pick(workbench, "8080");
  act(() => {
    workbench.editors.close(pfUri({ space: "prod-eu", id: 1 }));
  });
  await settle(4);
  act(() => {
    grid().focus();
  });
  letter("f");
  await settle(10);
  expect(workbench.quickAccess.session?.pick?.items[0]?.state).toBeDefined();
  await pick(workbench, "8080");
  expect(calls("forward_start")).toHaveLength(1);
  expect(workbench.editors.active).toBe(pfUri({ space: "prod-eu", id: 1 }));
});

test("⇧F is no key and Forward Port… no command, so a pod's key asks once and no other does", async () => {
  const { workbench, calls } = await listed();
  await selectFirst();
  letter("f", { shiftKey: true });
  await settle(10);
  expect(workbench.quickAccess.session).toBeUndefined();
  expect(calls("forward_ports")).toEqual([]);
  expect(
    workbench.commands
      .all()
      .filter(({ id }) => id.startsWith("k8s.resource.forward")),
  ).toHaveLength(1);
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
    expect(items.includes("Forward Port…")).toBe(false);
    expect(invoke.mock.calls.some(([name]) => name === "forward_ports")).toBe(
      forwardable,
    );
  },
);

const APPS = { group: "apps", version: "v1" };

test.each([
  ["a Service", SERVICES, "payments-gateway", "Service", true],
  [
    "a Deployment",
    { ...APPS, resource: "deployments" },
    "payments-api",
    "Deployment",
    true,
  ],
  [
    "a ReplicaSet",
    { ...APPS, resource: "replicasets" },
    "payments-api-6d8b9c7f5",
    "ReplicaSet",
    true,
  ],
  [
    "a StatefulSet",
    { ...APPS, resource: "statefulsets" },
    "db",
    "StatefulSet",
    false,
  ],
  [
    "a DaemonSet",
    { ...APPS, resource: "daemonsets" },
    "node-exporter",
    "DaemonSet",
    false,
  ],
])(
  "f on %s asks the core for its ports, and starts one where it declares any",
  async (_name, gvr, name, kind, starts) => {
    const { workbench, calls } = await listed();
    const target = { space: "prod-eu", gvr, namespace: "payments", name };
    const run = workbench.commands.execute(
      "k8s.forward.open",
      workbench.keys.lookup(null),
      target,
    );
    await settle(8);
    const asking = workbench.quickAccess.session?.pick;
    if (asking) await pick(workbench, asking.items[0]?.id);
    await run;
    await settle(6);
    expect(calls("forward_ports")).toEqual([target]);
    expect(calls("forward_start")).toHaveLength(starts ? 1 : 0);
    if (starts) {
      expect(workbench.editors.active).toBe(pfUri({ space: "prod-eu", id: 1 }));
    } else {
      expect(live().join("\n")).toContain(
        `${kind} ${name} declares no TCP port to forward`,
      );
    }
  },
);

test.each([
  ["a Job", { ...APPS, group: "batch", resource: "jobs" }],
  ["a ConfigMap", { group: "", version: "v1", resource: "configmaps" }],
  [
    "a Pod's Service account",
    { group: "", version: "v1", resource: "serviceaccounts" },
  ],
])(
  "f on %s asks nothing, since it has no port to forward",
  async (_name, gvr) => {
    const { workbench, calls } = await listed();
    await workbench.commands.execute(
      "k8s.forward.open",
      workbench.keys.lookup(null),
      { space: "prod-eu", gvr, namespace: "payments", name: "x" },
    );
    await settle(6);
    expect(calls("forward_ports")).toEqual([]);
    expect(live()).toEqual([]);
  },
);

test("the object editors of a Service and a workload offer Forward in their header, and others do not", async () => {
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

test("Forward in an object editor's header asks which port, and its pick starts that one", async () => {
  const { workbench, calls } = await listed();
  act(() => {
    workbench.editors.open(
      "k8s://prod-eu/apps/v1/deployments/payments/payments-api",
    );
  });
  await settle(8);
  fireEvent.click(screen.getByRole("button", { name: "Forward" }));
  await settle(10);
  await pick(workbench, "8080");
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

test("a local port that is in use is not replaced: the toast offers the next, and a click takes it", async () => {
  const { workbench, calls } = await listed("forwardBusy");
  const run = forwardGateway(workbench);
  await settle(6);
  await pick(workbench, "80");
  await run;
  await settle(6);
  expect(live()).toEqual([
    "PE8080 is in use by another process or forward, so payments-gateway:http is not forwarded.Use 8081",
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

test("a start that fails opens its tab and says the target's own failure", async () => {
  const { workbench } = await listed("forwardFailed");
  const run = forwardGateway(workbench);
  await settle(6);
  await pick(workbench, "80");
  await run;
  await act(() => vi.advanceTimersByTimeAsync(FAILS_AFTER_MS + 100));
  expect(workbench.editors.active).toBe(pfUri({ space: "prod-eu", id: 1 }));
  expect(live()[0]).toMatch(
    /^PEpayments-gateway:http → 8080 failed: pod \S+ refused the connection to port 8080: nothing listens on it/,
  );
});

test("a start that the mode refuses starts nothing and says so as a warning in the gate's words", async () => {
  const { workbench, backend, calls } = await listed("forwardBlocked");
  const first = await act(() =>
    backend.invoke("forward_start", {
      target: GATEWAY,
      port: 9090,
      local: null,
    }),
  );
  expect(first.outcome).toBe("started");
  await act(() =>
    vi.advanceTimersByTimeAsync(READY_AFTER_MS + BLOCKED_AFTER_MS + 100),
  );
  const run = forwardGateway(workbench);
  await settle(6);
  await pick(workbench, "80");
  await run;
  await settle(6);
  expect(calls("forward_start")).toHaveLength(2);
  const [toast] = live();
  expect(toast).toMatch(
    /^PEpayments-gateway:http is not forwarded: prod-eu is read-only by prod-eu in \/Library\/Application Support\/Twigo\/policy\.json, so Twigo did not send get pods\/portforward in payments$/,
  );
  expect(
    document
      .querySelector('[data-sonner-toast] svg[class*="text-"]')
      ?.getAttribute("class"),
  ).toContain("text-warn");
  expect(workbench.editors.active).not.toMatch(/^pf:/);
  const ports = await backend.invoke("forward_ports", GATEWAY);
  expect(ports.ports.map(({ forward }) => forward)).toEqual([1, null, null]);
});

test("a start that a lock the person may lift refuses offers the unlock for 15 minutes, which a policy file's lock does not", async () => {
  const mock = createMockBackend("live");
  const unlock = vi.spyOn(mock, "invoke");
  const refusal = (source: Blocked["source"]) =>
    new IpcError(
      "policy.blocked",
      "prod-eu is read-only, so Twigo did not send it",
      {
        context: "prod-eu",
        mode: "read-only",
        source,
        class: "forward",
        reason: "mode",
        verb: "get",
        target: "pods/portforward in payments",
      },
    );
  let refused = refusal({ kind: "environment", environment: "production" });
  const backend: Backend = {
    invoke: (command, request) =>
      command === "forward_start"
        ? Promise.reject(refused)
        : mock.invoke(command, request),
    subscribe: (command, request, onMessage) =>
      mock.subscribe(command, request, onMessage),
  };
  const workbench = await openList(backend);
  await act(() => vi.advanceTimersByTimeAsync(1500));
  const start = async () => {
    const run = forwardGateway(workbench);
    await settle(6);
    await pick(workbench, "80");
    await run;
    await settle(6);
  };
  await start();
  expect(live()).toEqual([
    "PEpayments-gateway:http is not forwarded: prod-eu is read-only, so Twigo did not send itUnlock for 15 minutes",
  ]);
  fireEvent.click(toastButton("Unlock for 15 minutes"));
  await confirmAsking(workbench);
  await settle(6);
  expect(unlock).toHaveBeenCalledWith("command_plan", {
    action: "unlock",
    context: "prod-eu",
  });
  expect(
    workbench.catalog.find("prod-eu")?.access.unlockedUntil,
  ).not.toBeNull();

  refused = refusal({
    kind: "policyFile",
    file: "/etc/twigo/policy.json",
    pattern: "prod-*",
  });
  await start();
  expect(live()).toEqual([
    "PEpayments-gateway:http is not forwarded: prod-eu is read-only, so Twigo did not send it",
    "PEUnlocked prod-eu for 15 minutes",
  ]);
});

test("a busy port's toast that is dismissed starts nothing on the free port", async () => {
  const { workbench, calls, backend } = await listed("forwardBusy");
  const run = forwardGateway(workbench);
  await settle(6);
  await pick(workbench, "80");
  await run;
  await settle(6);
  expect(live()).toEqual([
    "PE8080 is in use by another process or forward, so payments-gateway:http is not forwarded.Use 8081",
  ]);
  fireEvent.click(toastButton("Dismiss"));
  await settle(8);
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(calls("forward_start")).toEqual([
    { target: GATEWAY, port: 80, local: null },
  ]);
  expect(workbench.editors.active).not.toMatch(/^pf:/);
  expect(live()).toEqual([]);
  const ports = await backend.invoke("forward_ports", GATEWAY);
  expect(ports.ports.map(({ forward }) => forward)).toEqual([null, null, null]);
});

function startFailing(mock: Backend, error: IpcError): Backend {
  return {
    invoke: (name, request) =>
      name === "forward_start"
        ? Promise.reject(error)
        : mock.invoke(name, request),
    subscribe: (name, request, onMessage) =>
      mock.subscribe(name, request, onMessage),
  };
}

test("a start that fails for another reason than a busy port or the mode is shown, in the core's words, and opens no tab", async () => {
  const mock = createMockBackend("live");
  const backend = startFailing(
    mock,
    new IpcError("forward.cluster-unanswered", "the cluster does not answer"),
  );
  const workbench = await openList(backend);
  await act(() => vi.advanceTimersByTimeAsync(1500));
  const run = forwardGateway(workbench);
  await settle(6);
  await pick(workbench, "80");
  await run;
  await settle(6);
  expect(live().join("\n")).toContain("the cluster does not answer");
  expect(workbench.editors.active).not.toMatch(/^pf:/);
  const icon = document.querySelector(
    '[data-sonner-toast] svg[class*="text-"]',
  );
  expect(icon?.getAttribute("class")).toContain("text-error");
});

test("two invocations at once ask once, and the pick makes one forward and one tab", async () => {
  const { workbench, calls, backend } = await listed();
  await selectFirst();
  letter("f");
  letter("f");
  await settle(10);
  await pick(workbench, "8080");
  expect(calls("forward_start")).toHaveLength(1);
  const forwards = await backend.subscribe(
    "forwards_watch",
    null,
    () => undefined,
  );
  expect(forwards.map(({ id }) => id)).toEqual([1]);
  expect(workbench.editors.active).toBe(pfUri({ space: "prod-eu", id: 1 }));
  expect(
    document.querySelectorAll('[role="tab"][aria-label*="http → 8080"]'),
  ).toHaveLength(1);
  expect(live()).toEqual([]);
});

test("a forward the mode refuses in place just after its start is told as a warning, not as a failure", async () => {
  const { workbench, backend } = await listed("forwardBlocked");
  await act(() =>
    backend.invoke("forward_start", {
      target: GATEWAY,
      port: 9090,
      local: null,
    }),
  );
  vi.setTimerTickMode("manual");
  await act(() =>
    vi.advanceTimersByTimeAsync(READY_AFTER_MS + BLOCKED_AFTER_MS - 200),
  );
  const run = forwardGateway(workbench);
  await act(() => vi.advanceTimersByTimeAsync(0));
  await pick(workbench, "80");
  await run;
  const [toast] = live();
  expect(toast).toMatch(
    /^PEpayments-gateway:http → 8080 failed: prod-eu is read-only by prod-eu in /,
  );
  const icon = document.querySelector(
    '[data-sonner-toast] svg[class*="text-"]',
  );
  expect(icon?.getAttribute("class")).toContain("text-warn");
  expect(icon?.getAttribute("class")).not.toContain("text-error");
});
