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

vi.mock("./edit/YamlEditor", () => ({ default: () => <div /> }));

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
  "CPU",
  "Memory",
  "Age",
  "",
];

describe("in a wide editor", () => {
  const layout = withScreenSize(1000);

  test("the details stand beside the list, whose columns leave as the details narrow it and come back as it widens", async () => {
    await openList();
    expect(headers()).toEqual(EVERY_COLUMN);
    fireEvent.click(rows()[0] ?? document.body);
    await settle(1);
    expect(shown().className).not.toContain("absolute");
    expect(shown().style.minWidth).toBe("320px");
    layout.resize(grid(), 530);
    expect(headers()).toEqual(["", "Name", "Ready", "Status", ""]);
    fireEvent.click(
      within(shown()).getByRole("button", { name: "Close details" }),
    );
    await settle(1);
    expect(details()).toBeNull();
    layout.resize(grid(), 1000);
    expect(headers()).toEqual(EVERY_COLUMN);
  });

  const ROOM = 600;
  const widthOf = () => shown().style.width;
  const strip = () =>
    within(shown()).getByRole("separator", { name: "Resize details" });
  const onScreen = () => {
    shown().getBoundingClientRect = () =>
      new DOMRect(0, 0, Math.min(Number.parseInt(widthOf(), 10), ROOM), 600);
  };
  const drag = (to: number) => {
    onScreen();
    fireEvent.pointerDown(strip(), { clientX: 700, pointerId: 1 });
    fireEvent.pointerMove(strip(), { clientX: to, pointerId: 1 });
    fireEvent.pointerUp(strip(), { pointerId: 1 });
  };

  test("the width the user dragged the details to is the app's: a close keeps it, and so does a restart", async () => {
    const backend = createMockBackend("ready");
    const workbench = await openList(backend);
    fireEvent.click(rows()[0] ?? document.body);
    await settle(1);
    expect(widthOf()).toBe("470px");
    drag(600);
    expect(widthOf()).toBe("570px");
    fireEvent.click(
      within(shown()).getByRole("button", { name: "Close details" }),
    );
    await settle(1);
    fireEvent.click(rows()[1] ?? document.body);
    await settle(1);
    expect(widthOf()).toBe("570px");
    drag(900);
    expect(widthOf()).toBe("370px");
    drag(1400);
    expect(widthOf()).toBe("320px");

    drag(500);
    const written = workbench.state.settled();
    await act(() => vi.advanceTimersByTimeAsync(100));
    await written;
    cleanup();
    await openList(backend);
    fireEvent.click(rows()[0] ?? document.body);
    await settle(1);
    expect(widthOf()).toBe("520px");
  });

  test("a drag starts from the width on screen and keeps the width it ended at, which the editor's room may have cut", async () => {
    const workbench = await openList(createMockBackend("ready"));
    workbench.sizes.set("inspector", 900);
    fireEvent.click(rows()[0] ?? document.body);
    await settle(1);
    expect(widthOf()).toBe("900px");
    onScreen();
    fireEvent.pointerDown(strip(), { clientX: 700, pointerId: 1 });
    fireEvent.pointerMove(strip(), { clientX: 650, pointerId: 1 });
    expect(widthOf()).toBe("650px");
    onScreen();
    fireEvent.pointerUp(strip(), { pointerId: 1 });
    expect(workbench.sizes.get("inspector")).toBe(ROOM);
    expect(widthOf()).toBe("600px");
  });

  test("a click on the resize strip changes no width", async () => {
    const workbench = await openList(createMockBackend("ready"));
    workbench.sizes.set("inspector", 900);
    fireEvent.click(rows()[0] ?? document.body);
    await settle(1);
    onScreen();
    fireEvent.pointerDown(strip(), { clientX: 700, pointerId: 1 });
    fireEvent.pointerUp(strip(), { pointerId: 1 });
    expect(workbench.sizes.get("inspector")).toBe(900);
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
    const owner = within(header ?? document.body).getByRole("button", {
      name: /^ReplicaSet /,
    });
    const name = owner.textContent.replace(/^ReplicaSet /, "");
    fireEvent.click(owner);
    await settle();
    expect(workbench.editors.active).toBe(
      `k8s://prod-eu/apps/v1/replicasets/overview/${name}`,
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

  test("the header's row is a pod's pinned verbs, then More, whose last item is Delete behind a separator", async () => {
    await openList();
    fireEvent.click(rows()[0] ?? document.body);
    await settle(1);
    const row = within(shown()).getByRole("toolbar", { name: "Pod actions" });
    expect(
      within(row)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Logs", "Shell", "Forward", "More"]);
    fireEvent.pointerDown(within(row).getByRole("button", { name: "More" }), {
      button: 0,
      ctrlKey: false,
    });
    const menu = screen.getByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.firstChild?.nextSibling?.firstChild?.textContent),
    ).toEqual(["Attach", "Forward Port…", "Delete"]);
    expect(
      menu.lastElementChild?.previousElementSibling?.getAttribute("role"),
    ).toBe("separator");
  });

  test("a pod whose Overview lists no running container draws Shell and Attach disabled, saying so, where a running pod's are enabled", async () => {
    await openList();
    const cell = (row: HTMLElement, column: string) =>
      row.querySelector(`[data-column="${column}"]`)?.textContent;
    const pod = (status: string, ready: string) => {
      const found = rows().find(
        (row) => cell(row, "Status") === status && cell(row, "Ready") === ready,
      );
      if (!found) throw new Error(`no ${status} pod of ${ready}`);
      return found;
    };
    const shell = () =>
      within(
        within(shown()).getByRole("toolbar", { name: "Pod actions" }),
      ).getByRole("button", { name: "Shell" });

    fireEvent.click(pod("Running", "1/1"));
    await settle(6);
    expect(shell().getAttribute("aria-disabled")).toBeNull();
    cleanup();

    await openList(
      createMockBackend("ready"),
      "k8s-list://prod-eu/v1/pods?q=CrashLoopBackOff",
    );
    fireEvent.click(pod("CrashLoopBackOff", "0/1"));
    await settle(1);
    expect(shell().getAttribute("aria-disabled")).toBeNull();
    await settle(6);
    expect(shell().getAttribute("aria-disabled")).toBe("true");
    act(() => {
      shell().focus();
    });
    expect(screen.getByRole("tooltip").textContent).toContain(
      "No container runs",
    );
    fireEvent.pointerDown(
      within(shown()).getByRole("button", { name: "More" }),
      { button: 0, ctrlKey: false },
    );
    const attach = within(screen.getByRole("menu")).getByRole("menuitem", {
      name: /^Attach/,
    });
    expect(attach.getAttribute("aria-disabled")).toBe("true");
    expect(attach.textContent).toContain("No container runs");
  });

  test("off the Overview a crash-looping pod's Shell runs, since the details no longer know its containers, which a batch may have started", async () => {
    const mock = createMockBackend("ready");
    let send: ((batch: ObjectBatch) => void) | undefined;
    let last: ObjectBatch | undefined;
    const backend: Backend = {
      invoke: (command, request) => mock.invoke(command, request),
      subscribe(command, request, onMessage) {
        if (command !== "object_open")
          return mock.subscribe(command, request, onMessage);
        const forward = onMessage as (batch: ObjectBatch) => void;
        send = forward;
        return mock.subscribe(command, request, (message) => {
          last = message as ObjectBatch;
          forward(last);
        });
      },
    };
    await openList(backend, "k8s-list://prod-eu/v1/pods?q=CrashLoopBackOff");
    const crashing = rows().find(
      (row) =>
        row.querySelector('[data-column="Status"]')?.textContent ===
          "CrashLoopBackOff" &&
        row.querySelector('[data-column="Ready"]')?.textContent === "0/1",
    );
    fireEvent.click(crashing ?? document.body);
    await settle(8);
    const shell = () =>
      within(
        within(shown()).getByRole("toolbar", { name: "Pod actions" }),
      ).getByRole("button", { name: "Shell" });
    expect(shell().getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(tab("YAML"));
    await settle(8);
    const batch = last;
    if (!send || !batch?.manifest) throw new Error("no object batches");
    const manifest = JSON.parse(batch.manifest) as {
      status: { containerStatuses: { state: unknown }[] };
    };
    for (const status of manifest.status.containerStatuses)
      status.state = { running: { startedAt: "2026-11-15T10:00:00Z" } };
    act(() => {
      send?.({
        ...batch,
        seq: batch.seq + 1,
        overview: null,
        events: null,
        related: null,
        usage: null,
        manifest: JSON.stringify(manifest),
      });
    });
    await settle(2);
    expect(shell().getAttribute("aria-disabled")).toBeNull();
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

  test("the details slide over the list, which keeps the columns its own width leaves it", async () => {
    await openList();
    const own = [
      "",
      "Name",
      "Namespace",
      "Ready",
      "Status",
      "Restarts",
      "Age",
      "",
    ];
    expect(headers()).toEqual(own);
    fireEvent.click(rows()[0] ?? document.body);
    await settle(1);
    expect(shown().className).toContain("absolute");
    expect(headers()).toEqual(own);
  });

  test("lying over the list, the details keep no minimum width, so a narrow editor's 85 % bounds them", async () => {
    await openList();
    fireEvent.click(rows()[0] ?? document.body);
    await settle(1);
    expect(shown().style.minWidth).toBe("");
  });

  test("before the object comes the row's CPU and Memory read as the grid prints them, and follow a poll", async () => {
    const script = scriptedPods(true);
    await openList(script.backend);
    const send = async (batch: ListBatch) => {
      act(() => {
        script.send(batch);
      });
      await settle(1);
    };
    await send(measuredBatch(1, 206_115_138, 41_349_759, true));
    fireEvent.click(rows()[0] ?? document.body);
    await settle(1);
    const value = (label: string) =>
      within(shown()).getByText(label, { selector: "dt" }).nextElementSibling
        ?.textContent;
    expect(value("CPU")).toBe("207m");
    expect(value("Memory")).toBe("39Mi");

    await send(measuredBatch(2, 1_500_000_000, 2 * 1024 * 1024 * 1024));
    expect(value("CPU")).toBe("1500m");
    expect(value("Memory")).toBe("2048Mi");

    await send(measuredBatch(3, null, null));
    expect(value("CPU")).toBe("–");
    expect(value("Memory")).toBe("–");
  });
});

function scriptedPods(unread = false) {
  const mock = createMockBackend("ready");
  let send: ((batch: ListBatch) => void) | undefined;
  const backend: Backend = {
    invoke: (command, request) =>
      command.startsWith("list_")
        ? Promise.resolve(null as never)
        : mock.invoke(command, request),
    subscribe(command, request, onMessage) {
      if (command === "object_open" && unread)
        return new Promise<never>(() => undefined);
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
    metrics: null,
  };
}

function measuredBatch(
  seq: number,
  cpu: number | null,
  memory: number | null,
  first = false,
): ListBatch {
  return {
    ...podsBatch(seq, { "web-1": "Running" }, first),
    total: 1,
    columns: first
      ? [
          { name: "Name", kind: "string", priority: 0 },
          { name: "Status", kind: "string", priority: 0 },
          { name: "CPU", kind: "cpu", priority: 0 },
          { name: "Memory", kind: "memory", priority: 0 },
        ]
      : null,
    upserts: [
      {
        id: "prod-eu/default/web-1",
        created: null,
        generated: null,
        cells: ["web-1", "Running", cpu, memory],
      },
    ],
    metrics: first ? "ready" : null,
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
