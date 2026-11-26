import { Profiler } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  Backend,
  ListBatch,
  ObjectBatch,
  ObjectEvent,
  ObjectParts,
  Overview,
  RequestOf,
} from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { inWorkbench, testWorkbench } from "@twigo/workbench/testing";
import { Details } from "./Details";
import type { Selected } from "./selection";
import { createServices } from "./services";
import {
  hoverIcons,
  narrowHeaderCopies,
  openList,
  settle,
  withScreenSize,
} from "../test/workbench";
import { NO_HEADER, ROLLOUT_STUCK } from "../test/object";

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

  test("the header shows the row's status as a pill, and its top owner and its node open", async () => {
    const workbench = await openList(
      createMockBackend("ready"),
      "k8s-list://prod-eu/v1/pods?q=CrashLoopBackOff",
    );
    fireEvent.click(rows()[0] ?? document.body);
    await settle();
    narrowHeaderCopies(layout, shown());
    const header = within(shown().querySelector("header") ?? document.body);
    const verdict = within(header.getByRole("group", { name: "Verdict" }));
    expect(verdict.getByText("CrashLoopBackOff").className).toContain(
      "text-error",
    );
    expect(verdict.getByText(/^Container \w+ keeps crashing$/)).toBeTruthy();
    const owner = header.getByRole("button", { name: /^Deployment / });
    const name = owner.ariaLabel?.replace(/^Deployment /, "");
    fireEvent.click(owner);
    await settle();
    expect(workbench.editors.active).toMatch(
      new RegExp(`^k8s://prod-eu/apps/v1/deployments/[^/]+/${name}$`),
    );

    const node = header.getByRole("button", { name: /^Node / });
    fireEvent.click(node);
    await settle();
    expect(workbench.editors.active).toMatch(
      /^k8s:\/\/prod-eu\/\/v1\/nodes\/[^/]+$/,
    );
  });

  test("a kind whose list has no health column, and whose object says nothing, has no third line", async () => {
    await openList(
      createMockBackend("ready"),
      "k8s-list://prod-eu/batch/v1/jobs",
    );
    fireEvent.click(rows()[0] ?? document.body);
    await settle();
    const job = screen.getByRole("complementary", { name: "Job details" });
    const header = within(job.querySelector("header") ?? document.body);
    expect(header.queryByRole("group", { name: "Verdict" })).toBeNull();
  });

  test("arrowing along pods, the strip keeps its four cells while the next object comes", async () => {
    await openList();
    focusGrid();
    key("KeyJ");
    key("Space", { key: " " });
    await settle(8);
    const strip = () => within(shown()).getByLabelText("Vitals");
    const terms = () =>
      within(strip())
        .getAllByRole("term")
        .map((term) => term.textContent);
    expect(terms()).toEqual(["Ready", "Restarts", "CPU", "Memory"]);
    key("KeyJ");
    expect(terms()).toEqual(["Ready", "Restarts", "CPU", "Memory"]);
    const cpu = () =>
      within(strip()).getByText("CPU", { selector: "dt" }).nextElementSibling;
    expect(cpu()?.textContent).toBe("–");
    await settle(8);
    expect(terms()).toEqual(["Ready", "Restarts", "CPU", "Memory"]);
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

  test("the header's row is a pod's pinned verbs, then More", async () => {
    await openList();
    fireEvent.click(rows()[0] ?? document.body);
    await settle(1);
    const row = within(shown()).getByRole("toolbar", { name: "Pod actions" });
    expect(
      within(row)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Logs", "Shell", "Forward", "More"]);
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

  test("a crash-looping pod's Shell is as disabled on the YAML view as on the Overview, and runs on both once a batch lists a running container", async () => {
    const mock = createMockBackend("ready");
    let send: ((batch: ObjectBatch) => void) | undefined;
    let described: Overview | undefined;
    let seq = 0;
    const backend: Backend = {
      invoke: (command, request) => mock.invoke(command, request),
      subscribe(command, request, onMessage) {
        if (command !== "object_open")
          return mock.subscribe(command, request, onMessage);
        const forward = onMessage as (batch: ObjectBatch) => void;
        send = forward;
        return mock.subscribe(command, request, (message) => {
          const batch = message as ObjectBatch;
          described = batch.overview ?? described;
          seq = batch.seq;
          forward(batch);
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
    expect(shell().getAttribute("aria-disabled")).toBe("true");

    if (!send || !described) throw new Error("no object batches");
    const running: Overview = {
      ...described,
      sections: described.sections.map((section) => ({
        ...section,
        blocks: section.blocks.map((block) =>
          block.type === "containers"
            ? {
                ...block,
                containers: block.containers.map((container) => ({
                  ...container,
                  state: container.state && {
                    ...container.state,
                    running: true,
                  },
                })),
              }
            : block,
        ),
      })),
    };
    act(() => {
      send?.({
        seq: seq + 1,
        status: { state: "ready" },
        exists: true,
        overview: running,
        manifest: null,
        events: null,
        related: null,
        usage: null,
      });
    });
    await settle(2);
    expect(shell().getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(tab("Overview"));
    await settle(2);
    expect(shell().getAttribute("aria-disabled")).toBeNull();
  });

  test("a kind with neither a health column nor vitals holds its third line while the next object comes, if the last one had a sentence", async () => {
    const mock = createMockBackend("ready");
    let said = "";
    const backend: Backend = {
      invoke: (command, request) => mock.invoke(command, request),
      subscribe(command, request, onMessage) {
        if (command !== "object_open")
          return mock.subscribe(command, request, onMessage);
        const send = onMessage as (batch: ObjectBatch) => void;
        const { name } = (request as RequestOf<"object_open">).object;
        return mock.subscribe(command, request, (message) => {
          const batch = message as ObjectBatch;
          send({
            ...batch,
            overview: batch.overview && {
              ...batch.overview,
              header: {
                ...batch.overview.header,
                vitals: [],
                sentence:
                  name === said ? [{ type: "text", text: "Is stale" }] : [],
              },
            },
          });
        });
      },
    };
    await openList(backend, "k8s-list://prod-eu/batch/v1/jobs");
    const [first, second] = rows();
    said = nameOf(first);
    const line = () =>
      within(
        screen.getByRole("complementary", { name: "Job details" }),
      ).queryByRole("group", { name: "Verdict" });
    fireEvent.click(first ?? document.body);
    await settle(8);
    expect(line()?.textContent).toBe("Is stale");
    fireEvent.click(second ?? document.body);
    await settle(1);
    expect(line()).not.toBeNull();
    await settle(8);
    expect(line()).toBeNull();
  });

  test("the details follow the Overview on every view, and the related objects only on their own", async () => {
    const backend = createMockBackend("ready");
    const subscribe = vi.spyOn(backend, "subscribe");
    const invoke = vi.spyOn(backend, "invoke");
    const parts = (): ObjectParts => {
      const sent = invoke.mock.calls.filter(
        ([command]) => command === "object_set_parts",
      );
      const last = sent[sent.length - 1];
      if (last) return (last[1] as RequestOf<"object_set_parts">).parts;
      const opened = subscribe.mock.calls.filter(
        ([command]) => command === "object_open",
      );
      return (opened[opened.length - 1]?.[1] as RequestOf<"object_open">).parts;
    };
    await openList(backend);
    fireEvent.click(rows()[0] ?? document.body);
    await settle(8);
    expect(parts()).toMatchObject({ overview: true, related: false });
    for (const [name, own] of [
      ["YAML", { manifest: true, related: false }],
      ["Events", { events: true, related: false }],
      ["Related", { related: true }],
    ] as const) {
      fireEvent.click(tab(name));
      await settle(4);
      expect(parts(), name).toMatchObject({ overview: true, ...own });
    }
  });

  test("the pill says the row's word until the object comes and the word the object printed once it has, which the YAML view shows alike", async () => {
    const mock = createMockBackend("ready");
    const backend: Backend = {
      invoke: (command, request) => mock.invoke(command, request),
      subscribe(command, request, onMessage) {
        if (command !== "object_open")
          return mock.subscribe(command, request, onMessage);
        const send = onMessage as (batch: ObjectBatch) => void;
        return mock.subscribe(command, request, (message) => {
          const batch = message as ObjectBatch;
          send({
            ...batch,
            overview: batch.overview && {
              ...batch.overview,
              header: {
                ...batch.overview.header,
                printed: batch.overview.header.printed.map((cell) =>
                  cell.column === "Status"
                    ? { ...cell, value: "Terminating" }
                    : cell,
                ),
              },
            },
          });
        });
      },
    };
    await openList(backend);
    const running = rows().find(
      (row) =>
        row.querySelector('[data-column="Status"]')?.textContent === "Running",
    );
    fireEvent.click(running ?? document.body);
    const verdict = () =>
      within(shown()).getByRole("group", { name: "Verdict" }).textContent;
    await settle(1);
    expect(verdict()).toMatch(/^Running/);
    await settle(6);
    expect(verdict()).toMatch(/^Terminating/);
    fireEvent.click(tab("YAML"));
    await settle(4);
    expect(verdict()).toMatch(/^Terminating/);
  });

  test("the pill of a Deployment that is 4/4 and past its progress deadline takes the tone of the core's finding, and the list's row keeps the list's", async () => {
    const mock = createMockBackend("ready");
    const backend: Backend = {
      invoke: (command, request) => mock.invoke(command, request),
      subscribe(command, request, onMessage) {
        if (command !== "object_open")
          return mock.subscribe(command, request, onMessage);
        const send = onMessage as (batch: ObjectBatch) => void;
        return mock.subscribe(command, request, (message) => {
          const batch = message as ObjectBatch;
          send({
            ...batch,
            overview: batch.overview && {
              header: {
                ...batch.overview.header,
                printed: batch.overview.header.printed.map((cell) =>
                  cell.column === "Ready" ? { ...cell, value: "4/4" } : cell,
                ),
                sentence: [{ type: "text", text: "The rollout is stuck" }],
              },
              sections: [ROLLOUT_STUCK, ...batch.overview.sections],
            },
          });
        });
      },
    };
    await openList(backend, "k8s-list://prod-eu/apps/v1/deployments");
    const healthy = rows().find((row) =>
      /^(\d+)\/\1$/.test(
        row.querySelector('[data-column="Ready"]')?.textContent ?? "",
      ),
    );
    expect(healthy).toBeDefined();
    expect(healthy?.hasAttribute("data-tone")).toBe(false);
    fireEvent.click(rows()[0] ?? document.body);
    const pill = () =>
      within(
        within(
          screen.getByRole("complementary", { name: "Deployment details" }),
        ).getByRole("group", { name: "Verdict" }),
      ).getByText(/^\d+\/\d+$/);
    await settle(1);
    expect(pill().className).not.toContain("text-error");
    await settle(8);
    expect(pill().textContent).toBe("4/4");
    expect(pill().className).toContain("text-error");
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

  test("the details slide over the list, which keeps the columns its own width leaves it, and keep no minimum width, so a narrow editor's 85 % bounds them", async () => {
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
    expect(shown().style.minWidth).toBe("");
    expect(headers()).toEqual(own);
  });

  test("lying over the list, the details leave its rows no hover icons, which would mount unseen and ask the cluster for nobody", async () => {
    const backend = createMockBackend("ready");
    const invoke = vi.spyOn(backend, "invoke");
    await openList(backend);
    const reviews = () =>
      invoke.mock.calls.filter(([command]) => command === "access_review")
        .length;
    const other = rows()[2];
    if (!other) throw new Error("no rows");
    const unasked = reviews();
    fireEvent.pointerEnter(other);
    await settle(2);
    expect(hoverIcons(other).length).toBeGreaterThan(0);
    expect(reviews()).toBeGreaterThan(unasked);
    fireEvent.pointerLeave(other);
    await settle(1);

    fireEvent.click(rows()[0] ?? document.body);
    await settle(2);
    expect(shown().className).toContain("absolute");
    const before = reviews();
    for (const row of rows().slice(1, 6)) {
      fireEvent.pointerEnter(row);
      await settle(2);
      expect(hoverIcons(row)).toEqual([]);
      fireEvent.pointerLeave(row);
    }
    expect(reviews()).toBe(before);
  });

  test("before the object comes the header already says the row's word, in its tone", async () => {
    const script = scriptedPods(true);
    await openList(script.backend);
    act(() => {
      script.send(podsBatch(1, { "web-1": "CrashLoopBackOff" }, true));
    });
    await settle(1);
    fireEvent.click(rows()[0] ?? document.body);
    await settle(1);
    const verdict = within(
      within(shown()).getByRole("group", { name: "Verdict" }),
    );
    expect(verdict.getByText("CrashLoopBackOff").className).toContain(
      "text-error",
    );
  });

  test("before the object comes a printed duration reads as the row's cell does, counted from the moment the row was received", async () => {
    const script = scriptedPods(true);
    await openList(script.backend);
    const batch = podsBatch(1, { "web-1": "Running" }, true);
    act(() => {
      script.send({
        ...batch,
        columns: [
          ...(batch.columns ?? []),
          {
            name: "Restarts",
            kind: "string",
            priority: 0,
            printsDuration: true,
          },
        ],
        upserts: batch.upserts.map((row) => ({
          ...row,
          received: new Date(Date.now() - 8000).toISOString(),
          cells: [...row.cells, "19 (2m46s ago)"],
        })),
      });
    });
    await settle(1);
    const [row] = rows();
    if (!row) throw new Error("no rows");
    fireEvent.click(row);
    await settle(1);
    const standIn = within(shown()).getByText("Restarts", {
      selector: "dt",
    }).nextElementSibling;
    const cell = row.querySelector<HTMLElement>('[data-column="Restarts"]');
    if (!standIn || !cell) throw new Error("no Restarts");
    expect(within(standIn as HTMLElement).getByText("2m54s ago")).toBeTruthy();
    expect(within(cell).getByText("2m54s ago")).toBeTruthy();
    expect(standIn.textContent).not.toContain("2m46s");
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

test("once the object has come, the measures a poll brings to the selected row draw the inspector no more", async () => {
  const pending = testWorkbench("ready");
  await vi.advanceTimersByTimeAsync(10);
  const workbench = await pending;
  const services = createServices(workbench);
  const uri = "k8s-list://prod-eu/v1/pods";
  const name = "payments-api-7f9c8d6b5-h8lbx";
  const selected: Selected = {
    gvr: { group: "", version: "v1", resource: "pods" },
    kind: "Pod",
    namespaced: true,
    columns: [{ name: "Name", kind: "string", priority: 0 }],
    row: {
      id: `prod-eu/payments/${name}`,
      created: null,
      received: "2026-11-16T12:00:00.000Z",
      generated: null,
      cells: [name],
    },
  };
  services.selection.set(uri, selected);
  let commits = 0;
  render(
    <Profiler
      id="details"
      onRender={() => {
        commits++;
      }}
    >
      <Details
        uri={uri}
        selected={selected}
        space="prod-eu"
        services={services}
        docked
        onOpen={() => undefined}
        onClose={() => undefined}
      />
    </Profiler>,
    { wrapper: inWorkbench(workbench) },
  );
  await settle(12);
  expect(
    screen.getByRole("tablist", { name: "Views of the object" }),
  ).toBeTruthy();
  commits = 0;
  act(() => {
    services.selection.measure(uri, {
      ...selected.row,
      cells: [name],
    });
  });
  expect(commits).toBe(0);
});

test("while the object has not come, the stand-in draws what a poll brings to the selected row", async () => {
  const mock = createMockBackend("ready");
  const backend: Backend = {
    invoke: (command, request) => mock.invoke(command, request),
    subscribe(command, request, onMessage) {
      if (command === "object_open") return new Promise<never>(() => undefined);
      return mock.subscribe(command, request, onMessage);
    },
  };
  const pending = testWorkbench("ready", backend);
  await vi.advanceTimersByTimeAsync(10);
  const workbench = await pending;
  const services = createServices(workbench);
  const uri = "k8s-list://prod-eu/v1/pods";
  const name = "payments-api-7f9c8d6b5-h8lbx";
  const selected: Selected = {
    gvr: { group: "", version: "v1", resource: "pods" },
    kind: "Pod",
    namespaced: true,
    columns: [
      { name: "Name", kind: "string", priority: 0 },
      { name: "Status", kind: "string", priority: 0 },
    ],
    row: {
      id: `prod-eu/payments/${name}`,
      created: null,
      received: "2026-11-16T12:00:00.000Z",
      generated: null,
      cells: [name, "Running"],
    },
  };
  services.selection.set(uri, selected);
  render(
    <Details
      uri={uri}
      selected={selected}
      space="prod-eu"
      services={services}
      docked
      onOpen={() => undefined}
      onClose={() => undefined}
    />,
    { wrapper: inWorkbench(workbench) },
  );
  await settle(12);
  const status = () =>
    within(shown()).getByText("Status", { selector: "dt" }).nextElementSibling
      ?.textContent;
  expect(status()).toBe("Running");
  act(() => {
    services.selection.measure(uri, {
      ...selected.row,
      cells: [name, "Terminating"],
    });
  });
  await settle(2);
  expect(status()).toBe("Terminating");
});

const STOPPED_POD: Selected = {
  gvr: { group: "", version: "v1", resource: "pods" },
  kind: "Pod",
  namespaced: true,
  columns: [{ name: "Name", kind: "string", priority: 0 }],
  row: {
    id: "prod-eu/payments/payments-api-7f9c8d6b5-h8lbx",
    created: null,
    received: "2026-11-16T12:00:00.000Z",
    generated: null,
    cells: ["payments-api-7f9c8d6b5-h8lbx"],
  },
};

async function stopped(scenario: "listPanicked" | "objectPanicked") {
  const mock = createMockBackend(scenario);
  const opened = { count: 0 };
  const backend: Backend = {
    invoke: (command, request) => mock.invoke(command, request),
    subscribe(command, request, onMessage) {
      if (command === "object_open") opened.count++;
      return mock.subscribe(command, request, onMessage);
    },
  };
  const pending = testWorkbench("ready", backend);
  await vi.advanceTimersByTimeAsync(10);
  const workbench = await pending;
  render(
    <Details
      uri="k8s-list://prod-eu/v1/pods"
      selected={STOPPED_POD}
      space="prod-eu"
      services={createServices(workbench)}
      docked
      onOpen={() => undefined}
      onClose={() => undefined}
    />,
    { wrapper: inWorkbench(workbench) },
  );
  return opened;
}

test("an object that Twigo stopped before its overview came offers Reopen beside Report…, and Reopen subscribes it anew", async () => {
  const opened = await stopped("listPanicked");
  await settle(12);
  expect(within(shown()).getByText("This view stopped.")).toBeTruthy();
  expect(within(shown()).getByRole("button", { name: "Report…" })).toBeTruthy();
  const before = opened.count;
  fireEvent.click(within(shown()).getByRole("button", { name: "Reopen" }));
  await settle(12);
  expect(opened.count).toBeGreaterThan(before);
});

test("an object that Twigo stopped after its overview came offers Reopen too", async () => {
  const opened = await stopped("objectPanicked");
  await settle(12);
  await act(() => vi.advanceTimersByTimeAsync(7000));
  expect(within(shown()).getByText("This view stopped.")).toBeTruthy();
  const before = opened.count;
  fireEvent.click(within(shown()).getByRole("button", { name: "Reopen" }));
  await settle(12);
  expect(opened.count).toBeGreaterThan(before);
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
    view: 0,
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
      received: "2026-11-16T12:00:00.000Z",
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
        received: "2026-11-16T12:00:00.000Z",
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
    header: NO_HEADER,
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
