import {
  act,
  cleanup,
  fireEvent,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  Backend,
  ListBatch,
  ObjectBatch,
  ObjectEvent,
  Overview,
} from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { openList, settle, withScreenSize } from "../test/workbench";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

const rows = () => screen.getAllByRole("row").slice(1);
const nameOf = (row: HTMLElement | undefined) =>
  row?.querySelector('[data-column="Name"]')?.textContent ?? "";
const headers = () =>
  screen.getAllByRole("columnheader").map((header) => header.textContent);
const details = () =>
  screen.queryByRole("complementary", { name: "Pod details" });
const shown = () => {
  const aside = details();
  if (!aside) throw new Error("no details");
  return aside;
};
const grid = () => screen.getByRole("grid");
const key = (code: string, init: KeyboardEventInit = {}) => {
  fireEvent.keyDown(grid(), { code, key: code, ...init });
};
const focusGrid = () => {
  act(() => {
    grid().focus();
  });
};
const tab = (name: string) =>
  within(
    within(shown()).getByRole("tablist", { name: "Views of the object" }),
  ).getByRole("tab", { name: new RegExp(`^${name}`) });
const EVERY_COLUMN = [
  "",
  "Name",
  "Namespace",
  "Ready",
  "Status",
  "Restarts",
  "Age",
  "",
];

describe("in a wide editor", () => {
  withScreenSize(1000);

  test("the details stand beside the list, which keeps its name, ready and status columns until they close", async () => {
    await openList();
    expect(headers()).toEqual(EVERY_COLUMN);
    fireEvent.click(rows()[0] ?? document.body);
    await settle(1);
    expect(shown().className).not.toContain("absolute");
    expect(headers()).toEqual(["", "Name", "Ready", "Status", ""]);
    fireEvent.click(
      within(shown()).getByRole("button", { name: "Close details" }),
    );
    await settle(1);
    expect(details()).toBeNull();
    expect(headers()).toEqual(EVERY_COLUMN);
  });

  test("the header shows the row's status as a pill, and its controlling owner opens the owner", async () => {
    const workbench = await openList(
      createMockBackend("ready"),
      "k8s-list://prod-eu/v1/pods?q=CrashLoopBackOff",
    );
    fireEvent.click(rows()[0] ?? document.body);
    await settle();
    const header = shown().querySelector("header");
    const pill = within(header ?? document.body).getByText("CrashLoopBackOff");
    expect(pill.className).toContain("text-error");
    fireEvent.click(
      within(header ?? document.body).getByRole("button", {
        name: "ReplicaSet web-8dc77bb87",
      }),
    );
    await settle();
    expect(workbench.editors.active).toBe(
      "k8s://prod-eu/apps/v1/replicasets/overview/web-8dc77bb87",
    );
  });

  test("e opens the details on YAML, and the view stays as the selection moves", async () => {
    await openList();
    focusGrid();
    key("KeyJ");
    await settle(2);
    expect(details()).toBeNull();
    key("KeyE");
    await settle();
    expect(shown().textContent).toContain(nameOf(rows()[0]));
    expect(tab("YAML").getAttribute("aria-selected")).toBe("true");
    expect(
      within(shown()).getByRole("tabpanel", { name: "YAML" }),
    ).toBeTruthy();

    key("KeyJ");
    await settle();
    expect(shown().textContent).toContain(nameOf(rows()[1]));
    expect(tab("YAML").getAttribute("aria-selected")).toBe("true");
    expect(tab("Overview").getAttribute("aria-selected")).toBe("false");
  });

  test("Space shows the details of the cursor's row and hides them again", async () => {
    await openList();
    focusGrid();
    key("KeyJ");
    await settle(2);
    expect(details()).toBeNull();
    key("Space", { key: " " });
    await settle(1);
    expect(shown().textContent).toContain(nameOf(rows()[0]));
    key("Space", { key: " " });
    await settle(1);
    expect(details()).toBeNull();
    expect(
      rows()[0]?.querySelector("[role=checkbox]")?.getAttribute("aria-checked"),
    ).toBe("false");
  });

  test("the details follow their row as it changes, and stay closed once closed", async () => {
    const script = scriptedPods();
    await openList(script.backend);
    const send = async (batch: ListBatch) => {
      act(() => {
        script.send(batch);
      });
      await settle(1);
    };
    await send(podsBatch(1, { "web-1": "Running", "web-2": "Running" }, true));
    fireEvent.contextMenu(rows()[0] ?? document.body);
    fireEvent.click(screen.getByRole("menuitem", { name: "Open Details" }));
    await settle(1);
    const header = () => shown().querySelector("header") ?? document.body;
    expect(within(header()).getByText("Running")).toBeTruthy();

    await send(podsBatch(2, { "web-1": "CrashLoopBackOff" }));
    expect(within(header()).getByText("CrashLoopBackOff")).toBeTruthy();
    expect(within(shown()).getAllByText("CrashLoopBackOff")).toHaveLength(2);
    expect(within(header()).queryByText("Running")).toBeNull();

    fireEvent.click(
      within(shown()).getByRole("button", { name: "Close details" }),
    );
    await send(podsBatch(3, { "web-1": "Error" }));
    expect(details()).toBeNull();
  });

  test("the Events tab counts the object's warnings", async () => {
    await openList(withWarnings(2));
    fireEvent.click(rows()[0] ?? document.body);
    await settle();
    expect(tab("Events").textContent).toBe("Events2");
    expect(tab("Overview").textContent).toBe("Overview");
  });
});

describe("in a narrow editor", () => {
  withScreenSize(800);

  test("the details slide over the list, which keeps every column", async () => {
    await openList();
    fireEvent.click(rows()[0] ?? document.body);
    await settle(1);
    expect(shown().className).toContain("absolute");
    expect(headers()).toEqual(EVERY_COLUMN);
  });
});

function scriptedPods() {
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

function podsBatch(
  seq: number,
  statuses: Record<string, string>,
  first = false,
): ListBatch {
  const ids = Object.keys(statuses).map((name) => `prod-eu/default/${name}`);
  return {
    seq,
    total: 2,
    columns: first
      ? [
          { name: "Name", kind: "string", priority: 0 },
          { name: "Status", kind: "string", priority: 0 },
        ]
      : null,
    window: first ? { start: 0, ids } : null,
    upserts: Object.entries(statuses).map(([name, status]) => ({
      id: `prod-eu/default/${name}`,
      created: null,
      generated: null,
      cells: [name, status],
    })),
    status: { state: "ready" },
    counts: null,
    groups: null,
  };
}

function warning(index: number): ObjectEvent {
  return {
    type: "Warning",
    reason: "BackOff",
    message: `Back-off restarting failed container ${String(index)}`,
    source: "kubelet",
    count: 1,
    first: "2026-11-02T21:04:52Z",
    last: "2026-11-02T21:04:52Z",
    fieldPath: null,
  };
}

function withWarnings(count: number): Backend {
  const mock = createMockBackend("ready");
  const added = Array.from({ length: count }, (_, index) => warning(index));
  const overview = (document: Overview): Overview => ({
    sections: document.sections.map((section) => ({
      ...section,
      blocks: section.blocks.map((block) =>
        block.type === "events"
          ? { ...block, events: [...added, ...block.events] }
          : block,
      ),
    })),
  });
  return {
    invoke: (command, request) => mock.invoke(command, request),
    subscribe(command, request, onMessage) {
      if (command !== "object_open")
        return mock.subscribe(command, request, onMessage);
      const send = onMessage as (batch: ObjectBatch) => void;
      return mock.subscribe(command, request, (message) => {
        const batch = message as ObjectBatch;
        send({
          ...batch,
          overview: batch.overview && overview(batch.overview),
          events: batch.events && {
            ...batch.events,
            events: [...added, ...batch.events.events],
          },
        });
      });
    },
  };
}
