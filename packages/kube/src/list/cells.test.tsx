import { Profiler } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Column, Gvr, Row } from "@twigo/protocol";
import { columnRule, rowFinished, rowTone, statusColumn } from "../columns";
import { PODS } from "../kinds";
import { raisesAlarm } from "./alarm";
import { CellView, type ShownColumn } from "./cells";

const RECEIVED = "2026-11-16T12:00:00.000Z";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(Date.parse(RECEIVED));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

const DEPLOYMENTS: Gvr = {
  group: "apps",
  version: "v1",
  resource: "deployments",
};
const SERVICES: Gvr = { group: "", version: "v1", resource: "services" };
const NODES: Gvr = { group: "", version: "v1", resource: "nodes" };
const cellOf = (
  gvr: Gvr,
  name: string,
  cell: string,
  tone: "error" | "warn" | undefined,
  {
    kind = "string",
    printsDuration = false,
    alarmed = false,
    finished = false,
    received = RECEIVED,
  }: {
    kind?: Column["kind"];
    printsDuration?: boolean;
    alarmed?: boolean;
    finished?: boolean;
    received?: string;
  } = {},
) => {
  const row: Row = {
    id: "r",
    created: null,
    received,
    generated: null,
    cells: [cell],
  };
  const shown = {
    name,
    index: 0,
    rule: columnRule(gvr, { name, kind, priority: 0, printsDuration }),
  };
  return render(
    <CellView
      row={row}
      column={shown}
      tone={tone}
      alarmed={alarmed}
      finished={finished}
    />,
  ).container;
};

const warns = (container: HTMLElement) =>
  container.querySelector(".text-warn-foreground") !== null;

test("a pod's ready ratio short of its total is a warning, unless its status already carries the row's tone", () => {
  expect(warns(cellOf(PODS, "Ready", "0/1", undefined))).toBe(true);
  cleanup();
  expect(warns(cellOf(PODS, "Ready", "0/1", "error"))).toBe(false);
  cleanup();
  expect(warns(cellOf(PODS, "Ready", "0/1", "warn"))).toBe(false);
  cleanup();
  expect(warns(cellOf(PODS, "Ready", "1/1", undefined))).toBe(false);
});

test("a Deployment's ready ratio is its health column, so it stays a warning when the row has a tone", () => {
  expect(warns(cellOf(DEPLOYMENTS, "Ready", "1/2", "warn"))).toBe(true);
});

const tabular = (container: HTMLElement) =>
  container.querySelector(".tabular-nums") !== null;

test("a cell of a column the server declares a string is tabular when its text is figures or addresses", () => {
  const cases: [Gvr, string, string, boolean][] = [
    [DEPLOYMENTS, "Up-to-date", "40", true],
    [DEPLOYMENTS, "Up-to-date", "<none>", false],
    [SERVICES, "Cluster-IP", "10.96.0.1", true],
    [PODS, "Status", "Running", false],
    [PODS, "Node", "worker-1", false],
  ];
  for (const [gvr, name, cell, expected] of cases) {
    expect([name, cell, tabular(cellOf(gvr, name, cell, undefined))]).toEqual([
      name,
      cell,
      expected,
    ]);
    cleanup();
  }
});

const receded = (container: HTMLElement) =>
  container.querySelector(".text-support")?.textContent ?? null;

test("a healthy row's Ready and Status recede into support, and an abnormal row's do not", () => {
  const cases: [Gvr, string, string, "error" | "warn" | undefined, boolean][] =
    [
      [PODS, "Status", "Running", undefined, true],
      [PODS, "Ready", "1/1", undefined, true],
      [PODS, "Status", "CrashLoopBackOff", "error", false],
      [PODS, "Status", "ContainerCreating", "warn", false],
      [PODS, "Ready", "0/1", "error", false],
      [PODS, "Ready", "0/1", undefined, false],
      [NODES, "Status", "Ready", undefined, true],
      [NODES, "Status", "NotReady", "error", false],
      [DEPLOYMENTS, "Ready", "3/3", undefined, true],
      [DEPLOYMENTS, "Ready", "1/3", "warn", false],
      [SERVICES, "Type", "ClusterIP", undefined, false],
    ];
  for (const [gvr, name, cell, tone, expected] of cases) {
    expect([
      name,
      cell,
      tone,
      receded(cellOf(gvr, name, cell, tone)) !== null,
    ]).toEqual([name, cell, tone, expected]);
    cleanup();
  }
});

test("an abnormal status is in weight 600 beside its dot, a healthy one is not", () => {
  const bold = (container: HTMLElement) =>
    container.querySelector(".font-semibold")?.textContent ?? null;
  expect(bold(cellOf(PODS, "Status", "CrashLoopBackOff", "error"))).toBe(
    "CrashLoopBackOff",
  );
  cleanup();
  expect(bold(cellOf(PODS, "Status", "Running", undefined))).toBeNull();
  cleanup();
  expect(bold(cellOf(DEPLOYMENTS, "Ready", "1/3", "warn"))).toBe("1/3");
  cleanup();
  expect(bold(cellOf(PODS, "Ready", "0/1", undefined))).toBeNull();
});

function restarts(text: string, alarmed: boolean) {
  const container = cellOf(PODS, "Restarts", text, undefined, {
    kind: "integer",
    printsDuration: true,
    alarmed,
  });
  const [count, ago] = Array.from(container.querySelectorAll("span"));
  const role = (span: Element | undefined) =>
    span === undefined
      ? null
      : (["text-quiet", "text-support", "text-warn-foreground"].find((name) =>
          span.classList.contains(name),
        ) ?? "content");
  return { count: role(count), ago: role(ago) };
}

test("restarts read in three steps: a zero is quiet, a restart within the hour is a warning, any other count is plain with its age in support", () => {
  expect(restarts("0", false)).toEqual({ count: "text-quiet", ago: null });
  expect(restarts("3 (5m ago)", false)).toEqual({
    count: "text-warn-foreground",
    ago: "text-warn-foreground",
  });
  expect(restarts("3 (13s ago)", false).count).toBe("text-warn-foreground");
  expect(restarts("3 (59m ago)", false).count).toBe("text-warn-foreground");
  for (const ago of ["60m", "1h", "5h20m", "23h", "2d1h", "12d", "2y1d"]) {
    expect([ago, restarts(`3 (${ago} ago)`, false)]).toEqual([
      ago,
      { count: "content", ago: "text-support" },
    ]);
  }
});

test("a count with no readable age is plain, and a row that already raises an alarm has no second", () => {
  expect(restarts("3", false)).toEqual({ count: "content", ago: null });
  expect(restarts("3 (soon ago)", false)).toEqual({
    count: "content",
    ago: "text-support",
  });
  expect(restarts("3 (5m ago)", true)).toEqual({
    count: "content",
    ago: "text-support",
  });
});

const POD_COLUMNS: Column[] = [
  { name: "Ready", kind: "string", priority: 0 },
  { name: "Status", kind: "string", priority: 0 },
  { name: "Restarts", kind: "string", priority: 0, printsDuration: true },
];

function podRow(
  ready: string,
  status: string,
  restartsText: string,
  hidden?: string,
) {
  const row: Row = {
    id: "r",
    created: null,
    received: RECEIVED,
    generated: null,
    cells: [ready, status, restartsText],
  };
  const shown = POD_COLUMNS.flatMap((column, index) =>
    column.name === hidden
      ? []
      : [{ name: column.name, index, rule: columnRule(PODS, column) }],
  );
  const tone = rowTone(PODS, statusColumn(PODS), POD_COLUMNS, row);
  const finished = rowFinished(PODS, statusColumn(PODS), POD_COLUMNS, row);
  const alarmed = raisesAlarm(row, shown, tone, finished);
  const toned = (column: ShownColumn) =>
    render(
      <CellView
        row={row}
        column={column}
        tone={tone}
        alarmed={alarmed}
        finished={finished}
      />,
    ).container.querySelector(".text-warn-foreground, .text-error") !== null;
  return {
    alarmed,
    toned: Object.fromEntries(
      shown.map((column) => [column.name, toned(column)]),
    ),
    row,
    shown,
  };
}

test("a row raises one alarm: a short Ready with a restart 46 minutes ago warns in Ready only, and a restart warns alone where nothing else in the row does", () => {
  const read = (...cells: [string, string, string]) => {
    const { alarmed, toned } = podRow(...cells);
    return { alarmed, toned };
  };
  expect(read("0/1", "Running", "1 (46m ago)")).toEqual({
    alarmed: true,
    toned: { Ready: true, Status: false, Restarts: false },
  });
  expect(read("1/1", "Running", "1 (46m ago)")).toEqual({
    alarmed: false,
    toned: { Ready: false, Status: false, Restarts: true },
  });
  expect(read("0/1", "Running", "1 (3h ago)")).toEqual({
    alarmed: true,
    toned: { Ready: true, Status: false, Restarts: false },
  });
  expect(read("0/1", "CrashLoopBackOff", "5 (46m ago)")).toEqual({
    alarmed: true,
    toned: { Ready: false, Status: true, Restarts: false },
  });
});

test("a toned status alone silences a restart within the hour, whether Ready is full or the person hid it", () => {
  expect(podRow("1/1", "CrashLoopBackOff", "5 (46m ago)")).toMatchObject({
    alarmed: true,
    toned: { Ready: false, Status: true, Restarts: false },
  });
  expect(
    podRow("0/1", "CrashLoopBackOff", "1 (29m ago)", "Ready"),
  ).toMatchObject({
    alarmed: true,
    toned: { Status: true, Restarts: false },
  });
});

test("only a value that is drawn raises the alarm: a Ready the person hid raises none, and one merged into Status does", () => {
  const { row, shown } = podRow("0/1", "Running", "1 (46m ago)");
  const [ready, status, restarts] = shown;
  if (!ready || !status || !restarts) throw new Error("no columns");
  expect(raisesAlarm(row, [status, restarts], undefined, false)).toBe(false);
  expect(
    raisesAlarm(row, [{ ...status, merged: ready }], undefined, false),
  ).toBe(true);
});

test("a pod that ran to completion is not short of ready containers and its restarts are no news: nothing in its row raises an alarm", () => {
  expect(
    receded(cellOf(PODS, "Ready", "0/1", undefined, { finished: true })),
  ).toBe("0/1");
  cleanup();
  expect(
    warns(cellOf(PODS, "Ready", "0/2", undefined, { finished: true })),
  ).toBe(false);
  const read = (...cells: [string, string, string]) => {
    const { alarmed, toned } = podRow(...cells);
    return { alarmed, toned };
  };
  const quiet = { Ready: false, Status: false, Restarts: false };
  for (const status of ["Completed", "Succeeded", "ExitCode:0"]) {
    expect([status, read("0/1", status, "0")]).toEqual([
      status,
      { alarmed: false, toned: quiet },
    ]);
    expect([status, read("0/1", status, "1 (46m ago)")]).toEqual([
      status,
      { alarmed: false, toned: quiet },
    ]);
  }
  const { row, shown } = podRow("0/1", "Completed", "1 (46m ago)");
  const [ready0, status, restarts] = shown;
  if (!ready0 || !status || !restarts) throw new Error("no columns");
  expect(
    raisesAlarm(row, [{ ...status, merged: ready0 }], undefined, true),
  ).toBe(false);
});

test("a pod that ended badly keeps its tone in its Status, and Ready beside it stays plain", () => {
  for (const status of ["Error", "OOMKilled", "ExitCode:1", "Signal:9"]) {
    expect([status, podRow("0/1", status, "1 (46m ago)")]).toMatchObject([
      status,
      {
        alarmed: true,
        toned: { Ready: false, Status: true, Restarts: false },
      },
    ]);
  }
});

test("a restart within the hour stops warning when the hour passes, with no event from the server", () => {
  const container = cellOf(PODS, "Restarts", "3 (59m ago)", undefined, {
    kind: "integer",
    printsDuration: true,
  });
  const warns = () => container.querySelector(".text-warn-foreground") !== null;
  expect(warns()).toBe(true);
  advance(30_000);
  expect(warns()).toBe(true);
  advance(31_000);
  expect(warns()).toBe(false);
  expect(container.textContent).toContain("60m ago");
});

test("the age of a restart reads as the server prints it and grows with the clock", () => {
  const ago = (container: HTMLElement) =>
    container.querySelectorAll("span")[1]?.textContent;
  const restart = (printed: string) =>
    cellOf(PODS, "Restarts", `3 (${printed} ago)`, undefined, {
      kind: "integer",
      printsDuration: true,
    });
  const minutes = restart("5m");
  expect(ago(minutes)).toBe("5m ago");
  advance(60_000);
  expect(ago(minutes)).toBe("6m ago");
  cleanup();
  vi.setSystemTime(Date.parse(RECEIVED));
  const seconds = restart("13s");
  advance(5_000);
  expect(ago(seconds)).toBe("18s ago");
  cleanup();
  vi.setSystemTime(Date.parse(RECEIVED));
  const days = restart("2d1h");
  advance(60 * 60_000);
  expect(ago(days)).toBe("2d2h ago");
});

test("a row printed again with the age that follows from the first print shows the same age, and a count with no age shows none", () => {
  const row = (text: string, received: string): Row => ({
    id: "r",
    created: null,
    received,
    generated: null,
    cells: [text],
  });
  const shown = {
    name: "Restarts",
    index: 0,
    rule: columnRule(PODS, {
      name: "Restarts",
      kind: "integer",
      priority: 0,
      printsDuration: true,
    }),
  };
  const draw = (current: Row) => (
    <CellView
      row={current}
      column={shown}
      tone={undefined}
      alarmed={false}
      finished={false}
    />
  );
  const ago = (container: HTMLElement) =>
    container.querySelectorAll("span")[1]?.textContent;
  const { container, rerender } = render(draw(row("3 (47m ago)", RECEIVED)));
  advance(70_000);
  expect(ago(container)).toBe("48m ago");
  rerender(
    draw(row("3 (48m ago)", new Date(Date.now() - 10_000).toISOString())),
  );
  expect(ago(container)).toBe("48m ago");
  rerender(draw(row("4", new Date().toISOString())));
  expect(ago(container)).toBeUndefined();
});

test("a time since something else that the server printed grows too, whether a known column or a date a custom resource prints", () => {
  const CRONJOBS: Gvr = { group: "batch", version: "v1", resource: "cronjobs" };
  const EVENTS: Gvr = { group: "", version: "v1", resource: "events" };
  const WIDGETS: Gvr = {
    group: "example.com",
    version: "v1",
    resource: "widgets",
  };
  const cases: [Gvr, string, Column["kind"], string, string][] = [
    [CRONJOBS, "Last Schedule", "string", "10m", "11m"],
    [EVENTS, "Last Seen", "string", "119s", "2m59s"],
    [EVENTS, "First Seen", "string", "3h5m", "3h6m"],
    [WIDGETS, "Renewed", "date", "5m", "6m"],
  ];
  for (const [gvr, name, kind, printed, later] of cases) {
    vi.setSystemTime(Date.parse(RECEIVED));
    const container = cellOf(gvr, name, printed, undefined, {
      kind,
      printsDuration: true,
    });
    expect([name, container.textContent]).toEqual([name, printed]);
    advance(60_000);
    expect([name, container.textContent]).toEqual([name, later]);
    cleanup();
  }
  for (const [gvr, name, kind, none] of [
    [CRONJOBS, "Last Schedule", "string", "<none>"],
    [WIDGETS, "Renewed", "date", "<unknown>"],
    [WIDGETS, "Renewed", "date", "<invalid>"],
  ] as const) {
    vi.setSystemTime(Date.parse(RECEIVED));
    const container = cellOf(gvr, name, none, undefined, {
      kind,
      printsDuration: true,
    });
    advance(60_000);
    expect([name, container.textContent]).toEqual([name, none]);
    cleanup();
  }
});

test("a cell ticks where the core says its column prints a duration, in any resource, and is drawn as printed where it does not, whatever its name", () => {
  const cases: [Gvr, string, boolean, string, string][] = [
    [
      { group: "events.k8s.io", version: "v1", resource: "events" },
      "Last Seen",
      true,
      "5m",
      "6m",
    ],
    [
      { group: "example.com", version: "v1", resource: "crontabs" },
      "Last Seen",
      false,
      "5m",
      "5m",
    ],
    [
      { group: "", version: "v1", resource: "events" },
      "Last Seen",
      false,
      "5m",
      "5m",
    ],
    [PODS, "Restarts", true, "3 (5m ago)", "36m ago"],
    [PODS, "Restarts", false, "3 (5m ago)", "35m ago"],
  ];
  for (const [gvr, name, printsDuration, printed, later] of cases) {
    vi.setSystemTime(Date.parse(RECEIVED));
    const container = cellOf(gvr, name, printed, undefined, {
      printsDuration,
    });
    advance(60_000);
    expect([gvr.group, name, printsDuration, container.textContent]).toEqual([
      gvr.group,
      name,
      printsDuration,
      later,
    ]);
    cleanup();
  }
});

test("a stamp that cannot be read leaves the text as the server printed it, in the plain step", () => {
  const unusable = [
    "not a time",
    "",
    new Date(Date.parse(RECEIVED) + 10 * 60_000).toISOString(),
  ];
  for (const received of unusable) {
    vi.setSystemTime(Date.parse(RECEIVED));
    const restart = cellOf(PODS, "Restarts", "3 (5m ago)", undefined, {
      kind: "integer",
      printsDuration: true,
      received,
    });
    const [count, ago] = Array.from(restart.querySelectorAll("span"));
    expect([received, count?.textContent, ago?.textContent]).toEqual([
      received,
      "3",
      "5m ago",
    ]);
    expect(restart.querySelector(".text-warn-foreground")).toBeNull();
    expect(ago?.classList.contains("text-support")).toBe(true);
    const since = cellOf(
      { group: "batch", version: "v1", resource: "cronjobs" },
      "Last Schedule",
      "1m",
      undefined,
      { printsDuration: true, received },
    );
    advance(60_000);
    expect([received, restart.textContent, since.textContent]).toEqual([
      received,
      "35m ago",
      "1m",
    ]);
    cleanup();
  }
});

test("what raises a row's alarm does not depend on the time, so the one alarm of a row stays where it is as an hour passes", () => {
  const states = () => {
    const { alarmed, toned } = podRow("1/1", "Running", "1 (46m ago)");
    const failing = podRow("1/1", "CrashLoopBackOff", "1 (46m ago)");
    cleanup();
    return { alarmed, toned, failing: [failing.alarmed, failing.toned] };
  };
  const before = states();
  expect(before.toned.Restarts).toBe(true);
  advance(60 * 60_000);
  const after = states();
  expect(after.alarmed).toBe(before.alarmed);
  expect(after.failing).toEqual(before.failing);
});

test("an Age draws again only as its text or its role changes", () => {
  const ticked = (ago: number) => {
    vi.setSystemTime(Date.parse(RECEIVED));
    let commits = 0;
    const row: Row = {
      id: "r",
      created: new Date(Date.parse(RECEIVED) - ago).toISOString(),
      received: RECEIVED,
      generated: null,
      cells: [null],
    };
    const { container } = render(
      <Profiler
        id="age"
        onRender={() => {
          commits++;
        }}
      >
        <CellView
          row={row}
          column={{
            name: "Age",
            index: 0,
            rule: columnRule(PODS, { name: "Age", kind: "age", priority: 0 }),
          }}
          tone={undefined}
          alarmed={false}
          finished={false}
        />
      </Profiler>,
    );
    const first = commits;
    advance(5_000);
    const age = container.firstElementChild;
    return {
      commits: commits - first,
      text: age?.textContent,
      role: age?.className,
    };
  };
  expect(ticked(15 * 60_000 + 5_000)).toEqual({
    commits: 0,
    text: "15m",
    role: "text-support",
  });
  cleanup();
  expect(ticked(2 * 60_000 + 5_000)).toEqual({
    commits: 1,
    text: "2m10s",
    role: "text-content",
  });
  cleanup();
  expect(ticked(9 * 60_000 + 57_000)).toEqual({
    commits: 1,
    text: "10m",
    role: "text-support",
  });
});
