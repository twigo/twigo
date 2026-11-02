import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ListQuery, Sort } from "@twigo/protocol";
import { createMockBackend } from "@twigo/protocol/mock";
import { shows, SORTS, topRows } from "./driver";
import { ListProbe, Probe } from "./probe";

function query(sort: Sort | null): ListQuery {
  return {
    space: "prod-eu",
    gvr: { group: "", version: "v1", resource: "pods" },
    namespaced: true,
    namespaces: [],
    labelSelector: null,
    text: null,
    columns: null,
    sort,
    groupBy: null,
    values: null,
  };
}

async function firstRows(sort: Sort | null) {
  const probe = new Probe(createMockBackend("ready"));
  const opened = probe.next();
  const subscribed = probe.backend.subscribe(
    "list_subscribe",
    query(sort),
    () => undefined,
  );
  const list = await opened;
  await vi.advanceTimersByTimeAsync(0);
  const id = await subscribed;
  const windowed = probe.backend.invoke("list_set_window", {
    id,
    start: 0,
    end: 40,
  });
  await vi.advanceTimersByTimeAsync(50);
  await windowed;
  return topRows(list);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

test("every sort changes the first rows on the mock", async () => {
  let previous = await firstRows(null);
  expect(previous).toHaveLength(10);
  for (const sort of SORTS) {
    const rows = await firstRows(sort);
    expect(rows, `${sort.column} ${String(sort.descending)}`).not.toEqual(
      previous,
    );
    previous = rows;
  }
});

function table(rows: (readonly [string, string] | null)[]): HTMLElement {
  const grid = document.createElement("div");
  grid.setAttribute("role", "grid");
  grid.innerHTML = `<div role="row" aria-rowindex="1">${[
    "Name",
    "Namespace",
    "Status",
  ]
    .map((name) => `<button role="columnheader">${name}</button>`)
    .join("")}</div>`;
  rows.forEach((row, index) => {
    const element = document.createElement("div");
    element.setAttribute("role", "row");
    element.setAttribute("aria-rowindex", String(index + 2));
    element.innerHTML = row
      ? `<div role="gridcell">${row[0]}</div><div role="gridcell">${row[1]}</div><div role="gridcell">Running</div>`
      : "<div><span></span></div>";
    grid.append(element);
  });
  return grid;
}

test("the screen shows the rows only once every one of them is in place", () => {
  const expected = ["payments/api-2", "payments/api-1", "web/api-3"];
  expect(
    shows(
      table([
        ["api-2", "payments"],
        ["api-2", "web"],
        ["api-1", "payments"],
      ]),
      expected,
    ),
  ).toBe(false);
  expect(
    shows(
      table([["api-2", "payments"], ["api-1", "payments"], null]),
      expected,
    ),
  ).toBe(false);
  expect(
    shows(
      table([
        ["api-2", "payments"],
        ["api-1", "payments"],
        ["api-3", "web"],
        ["api-4", "web"],
      ]),
      expected,
    ),
  ).toBe(true);
});

test("the list's first rows are named as the screen's are, once its window starts at the top", () => {
  const list = new ListProbe();
  list.record(0, {
    seq: 1,
    total: 2,
    columns: [
      { name: "Name", kind: "string", priority: 0 },
      { name: "Namespace", kind: "string", priority: 0 },
    ],
    window: { start: 0, ids: ["b", "a"] },
    upserts: [
      { id: "a", created: null, cells: ["api-1", "payments"] },
      { id: "b", created: null, cells: ["api-2", "payments"] },
    ],
    status: { state: "ready" },
    groups: null,
  });
  expect(topRows(list)).toEqual(["payments/api-2", "payments/api-1"]);
  list.record(1, {
    seq: 2,
    total: 2,
    columns: null,
    window: { start: 1, ids: ["a", "b"] },
    upserts: [],
    status: { state: "ready" },
    groups: null,
  });
  expect(topRows(list)).toBeUndefined();
});
