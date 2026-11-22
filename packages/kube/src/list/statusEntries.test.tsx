import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  Backend,
  Discovered,
  ListBatch,
  Parts,
  PartState,
  ViewState,
} from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { StateStore, Workbench, WorkbenchView } from "@twigo/workbench";
import { openList, settle, withScreenSize } from "../../test/workbench";
import { cellTone } from "../columns";
import { PODS } from "../kinds";
import { registerKube } from "../register";
import { partsLine } from "./statusEntries";

withScreenSize();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test("the cluster's version comes once its credential does", async () => {
  const backend = createMockBackend("untrusted");
  const workbench = new Workbench(
    backend,
    "mac",
    { id: "us", keys: {} },
    await StateStore.load(backend, () => undefined),
  );
  registerKube(workbench);
  await act(() =>
    Promise.all([workbench.catalog.watch(), workbench.spaces.load()]),
  );
  await act(() => workbench.credentials.start());
  render(<WorkbenchView workbench={workbench} />);
  await act(() => vi.advanceTimersByTimeAsync(100));
  expect(screen.queryByText("v1.33.4")).toBeNull();

  const { auth } = workbench.credentials;
  if (auth.state !== "untrusted") throw new Error(auth.state);
  await act(() => workbench.credentials.trust(auth.plugin.digest));
  await act(() => vi.advanceTimersByTimeAsync(7000));
  expect(await screen.findByText("v1.33.4")).toBeTruthy();
});

const entry = (text: string) => screen.getByText(text).closest("[title]");

test("while connected only the version shows", async () => {
  await openList();
  expect(entry("v1.33.4")?.getAttribute("title")).toBe(
    "Connected · Kubernetes v1.33.4",
  );
  expect(screen.queryByText("Connected")).toBeNull();
});

test.each([
  ["queued", "Waiting for a stream slot", "Waiting"],
  ["connecting", "Connecting…", "Connecting"],
  ["syncing", "Loading · 1,850", "Syncing"],
  ["stale", "No updates · reconnecting", "Reconnecting"],
  ["relisting", "v1.33.4", "Connected"],
] as const)(
  "a %s list's cluster entry reads %s",
  async (scenario, text, connection) => {
    await openList(createMockBackend(scenario));
    expect(entry(text)?.getAttribute("title")).toBe(
      `${connection} · Kubernetes v1.33.4`,
    );
  },
);

test("the status bar counts the active list's rows", async () => {
  await openList();
  expect(screen.getByText("5,000 pods")).toBeTruthy();
});

test("a list of one row counts it by the resource's singular", async () => {
  await openList(
    undefined,
    "k8s-list://prod-eu/apps/v1/deployments?ns=payments&q=gateway",
  );
  expect(screen.getByText("1 deployment")).toBeTruthy();
  expect(screen.queryByText("1 deployments")).toBeNull();
});

test("a list of one row counts it by the words of the title of the kind discovery serves, whichever version it serves", async () => {
  const mock = createMockBackend("ready");
  const backend: Backend = {
    invoke: (command, request) => mock.invoke(command, request),
    subscribe: (command, request, onMessage) =>
      mock.subscribe(command, request, (message) => {
        const found = message as Discovered;
        onMessage(
          command === "resources_watch" && found.state === "ready"
            ? {
                ...found,
                resources: found.resources.map((resource) =>
                  resource.gvr.resource === "deployments"
                    ? {
                        ...resource,
                        kind: "StatefulSet",
                        gvr: { ...resource.gvr, version: "v1beta1" },
                      }
                    : resource,
                ),
              }
            : message,
        );
      }),
  };
  await openList(
    backend,
    "k8s-list://prod-eu/apps/v1/deployments?ns=payments&q=gateway",
  );
  expect(screen.getByText("1 stateful set")).toBeTruthy();
});

test("a list of all namespaces that leaves some out says how many it reads of how many there are, quietly", async () => {
  await openList(createMockBackend("rbacNamespaces"));
  await settle(30);
  const cluster = entry("1 of 12 namespaces");
  expect(cluster?.getAttribute("title")).toBe(
    [
      "Pods in the 1 namespace these credentials may list; 11 others are left out",
      "Connected · Kubernetes v1.33.4",
    ].join("\n"),
  );
  expect(cluster?.className).toContain("text-quiet");
  expect(screen.queryByText("v1.33.4")).toBeNull();
});

test("a list of all namespaces says connecting while the core works out which it reads, with no refusal and no count of one, and then how many it reads", async () => {
  const mock = createMockBackend("rbacNamespaces");
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const backend: Backend = {
    ...mock,
    invoke: (command, request) =>
      command === "list_ack"
        ? held.then(() => mock.invoke(command, request))
        : mock.invoke(command, request),
  };
  await openList(backend);
  await settle(10);
  expect(screen.getAllByText("Connecting…").length).toBeGreaterThan(0);
  expect(screen.queryByText(/Forbidden|may not list/)).toBeNull();
  expect(screen.queryByText(/ of \d+ namespaces$/)).toBeNull();

  release?.();
  await settle(30);
  expect(entry("1 of 12 namespaces")).toBeTruthy();
  expect(screen.queryByText("Connecting…")).toBeNull();
});

test("a selection, which leaves none out, keeps the cluster's version", async () => {
  await openList(
    createMockBackend("rbacNamespaces"),
    "k8s-list://prod-eu/v1/pods?ns=default",
  );
  await settle(30);
  expect(entry("v1.33.4")?.className).not.toContain("text-quiet");
  expect(screen.queryByText(/ of \d+ namespaces$/)).toBeNull();
});

const statusOf = (row: HTMLElement) =>
  row.querySelector('[data-column="Status"]')?.textContent ?? "";
const pressed = () =>
  screen
    .getAllByRole("button", { pressed: true })
    .map((button) => button.textContent);

test.each([
  ["failing", "error", "Failing"],
  ["pending", "warn", "Pending"],
] as const)(
  "the %s count is an entry whose click shows only those rows",
  async (name, tone, title) => {
    await openList();
    const count = screen.getByRole("button", {
      name: new RegExp(`^[\\d,]+ ${name}$`),
    });
    fireEvent.click(count);
    await settle();
    expect(pressed()).toEqual([expect.stringMatching(`^${title}`)]);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.filter((row) => cellTone(PODS, "Status", statusOf(row)) !== tone),
    ).toEqual([]);
    expect(
      screen.getByText(
        new RegExp(`^${count.textContent.split(" ")[0] ?? ""} pods$`),
      ),
    ).toBeTruthy();
  },
);

const FORBIDDEN: ViewState = {
  state: "forbidden",
  verb: "watch",
  resource: "pods",
};

const part = (name: string, state: ViewState, shown = false): PartState => ({
  part: { kind: "namespace", name },
  state,
  shown,
});

const of22 = (...unready: PartState[]): Parts => ({
  count: 22,
  unready,
  omitted: 0,
});

test.each([
  [
    "a forbidden part",
    of22(part("team-b", FORBIDDEN)),
    "Forbidden · 1 of 22 namespaces",
    "error",
    "team-b: You may not watch pods. · server.forbidden",
  ],
  [
    "a part in error",
    of22(
      part("team-b", {
        state: "error",
        error: {
          code: "connect.other",
          kind: "unavailable",
          message: "connection refused",
        },
      }),
    ),
    "Unreachable · 1 of 22 namespaces",
    "error",
    "team-b: connection refused · connect.other",
  ],
  [
    "parts that wait for a stream with no rows",
    of22(
      part("team-x", { state: "queued" }),
      part("team-y", { state: "queued" }),
    ),
    "Waiting for a stream slot · 2 of 22 namespaces",
    "warn",
    "team-x, team-y: no rows yet",
  ],
  [
    "a part that waits for a stream with its rows",
    of22(part("team-x", { state: "queued" }, true)),
    "Waiting for a stream slot · 1 of 22 namespaces",
    "warn",
    "team-x: rows as last listed",
  ],
  [
    "parts that sync",
    of22(
      part("team-a", { state: "syncing", loaded: 1000 }),
      part("team-b", { state: "syncing", loaded: 600 }),
      part("team-c", { state: "syncing", loaded: 250 }),
    ),
    "Loading · 1,850 · 3 of 22 namespaces",
    "warn",
    "team-a (1,000), team-b (600), team-c (250): loading",
  ],
  [
    "parts that connect and parts that sync",
    of22(
      part("team-a", { state: "connecting" }),
      part("team-b", { state: "syncing", loaded: 1200 }),
      part("team-c", { state: "syncing", loaded: 650 }),
    ),
    "Loading · 1,850 · 3 of 22 namespaces",
    "warn",
    "team-a: connecting\nteam-b (1,200), team-c (650): loading",
  ],
  [
    "parts that all connect",
    of22(
      part("team-a", { state: "connecting" }),
      part("team-b", { state: "connecting" }),
    ),
    "Connecting… · 2 of 22 namespaces",
    "warn",
    "team-a, team-b: connecting",
  ],
  [
    "a part without updates",
    of22(part("team-c", { state: "stale" }, true)),
    "No updates · reconnecting · 1 of 22 namespaces",
    "warn",
    "team-c: no updates, reconnecting",
  ],
  [
    "a part whose first list broke off",
    of22(part("team-c", { state: "stale" })),
    "Connecting… · 1 of 22 namespaces",
    "warn",
    "team-c: connecting",
  ],
  [
    "a part that relists",
    of22(part("team-c", { state: "relisting" }, true)),
    "Relisting… · 1 of 22 namespaces",
    "ok",
    "team-c: relisting",
  ],
] as const)(
  "%s says its words and tone and names its parts",
  (_, parts, text, tone, tooltip) => {
    expect(partsLine(parts)).toEqual({ text, tone, tooltip });
  },
);

test("several kinds of trouble: the worst leads and the tooltip lists the rest, the worst first", () => {
  expect(
    partsLine(
      of22(
        part("team-c", { state: "stale" }, true),
        part("team-x", { state: "queued" }),
        part("team-b", FORBIDDEN),
        part("team-d", FORBIDDEN),
      ),
    ),
  ).toEqual({
    text: "Forbidden · 2 of 22 namespaces",
    tone: "error",
    tooltip: [
      "team-b, team-d: You may not watch pods. · server.forbidden",
      "team-x: no rows yet",
      "team-c: no updates, reconnecting",
    ].join("\n"),
  });
});

test("a part of a kind the webview does not know is counted and not named", () => {
  const unknown = {
    part: { kind: "column", column: "Usage" },
    state: { state: "queued" },
    shown: false,
  } as unknown as PartState;
  expect(
    partsLine(of22(part("team-x", { state: "queued" }), unknown))?.tooltip,
  ).toBe("team-x and 1 more: no rows yet");
  expect(partsLine(of22(unknown))?.tooltip).toBe("1 part: no rows yet");
});

test("a list of one part, or with every part ready, says nothing of its parts", () => {
  expect(
    partsLine({ count: 1, unready: [part("team-b", FORBIDDEN)], omitted: 0 }),
  ).toBeUndefined();
  expect(partsLine({ count: 22, unready: [], omitted: 0 })).toBeUndefined();
});

const OWN = "k8s-list://prod-eu/v1/pods?ns=auth,default,payments";

test("a list that has the rows of one namespace says the others are refused, in the cluster entry", async () => {
  await openList(createMockBackend("rbacNamespaces"), OWN);
  await act(() => vi.advanceTimersByTimeAsync(1500));
  const forbidden = entry("Forbidden · 2 of 3 namespaces");
  expect(forbidden?.getAttribute("title")).toBe(
    "auth, payments: You may not watch pods. · server.forbidden\nKubernetes v1.33.4",
  );
  expect(screen.queryByText("Access denied")).toBeNull();
  expect(screen.getAllByRole("row").length).toBeGreaterThan(1);
});

test("a list whose only namespace that may be read is still loading is no denial yet", async () => {
  await openList(createMockBackend("rbacNamespaces"), OWN);
  expect(screen.queryByText("Access denied")).toBeNull();
  expect(screen.queryByRole("grid")).not.toBeNull();
});

test("a list in which every namespace is refused is replaced by the denial", async () => {
  await openList(
    createMockBackend("rbacNamespaces"),
    "k8s-list://prod-eu/v1/pods?ns=auth,payments",
  );
  expect(screen.getByText("Access denied")).toBeTruthy();
  expect(
    entry("Forbidden · 2 of 2 namespaces")?.getAttribute("title"),
  ).toContain("auth, payments: You may not watch pods. · server.forbidden");
});

test("a list whose last namespaces wait for a stream shows the rows it has and says so", async () => {
  await openList(
    createMockBackend("partsQueued"),
    "k8s-list://prod-eu/v1/pods?ns=auth,default,ledger,payments,search",
  );
  await act(() => vi.advanceTimersByTimeAsync(1500));
  expect(
    entry("Waiting for a stream slot · 2 of 5 namespaces")?.getAttribute(
      "title",
    ),
  ).toBe(
    "payments: rows as last listed\nsearch: no rows yet\nKubernetes v1.33.4",
  );
  expect(screen.getAllByRole("row").length).toBeGreaterThan(1);
});

test("a list of one part says what its part waits for, not that its updates stopped", async () => {
  const real = createMockBackend("ready");
  const backend: Backend = {
    invoke: (command, request) => real.invoke(command, request),
    subscribe: (command, request, onMessage) =>
      real.subscribe(command, request, (message) => {
        const batch = message as ListBatch;
        onMessage(
          command === "list_subscribe"
            ? {
                ...batch,
                status: { state: "stale" },
                parts: {
                  count: 1,
                  omitted: 0,
                  unready: [
                    {
                      part: { kind: "cluster" },
                      state: { state: "queued" },
                      shown: true,
                    },
                  ],
                },
              }
            : message,
        );
      }),
  };
  await openList(backend);
  expect(entry("Waiting for a stream slot")?.getAttribute("title")).toBe(
    "Waiting · Kubernetes v1.33.4",
  );
  expect(screen.queryByText("No updates · reconnecting")).toBeNull();
});
