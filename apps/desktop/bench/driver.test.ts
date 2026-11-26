import { expect, test, vi } from "vitest";
import type { ListBatch } from "@twigo/protocol";
import { answer, shownSort, shows, topRows } from "./driver";
import { ListProbe } from "./probe";

function table(rows: (readonly [string, string] | null)[]): HTMLElement {
  const grid = document.createElement("div");
  grid.setAttribute("role", "grid");
  grid.innerHTML = `<div role="row" aria-rowindex="1">${[
    "Name",
    "Namespace",
    "Status",
  ]
    .map(
      (name) =>
        `<div role="columnheader" aria-sort="none"><button type="button">${name}</button></div>`,
    )
    .join("")}</div>`;
  rows.forEach((row, index) => {
    const element = document.createElement("div");
    element.setAttribute("role", "row");
    element.setAttribute("aria-rowindex", String(index + 2));
    element.innerHTML = row
      ? `<div role="gridcell"></div><div role="gridcell" data-column="Name">${row[0]}</div><div role="gridcell" data-column="Namespace">${row[1]}</div><div role="gridcell" data-column="Status">Running</div><div role="gridcell"></div>`
      : "<div><span></span></div>";
    grid.append(element);
  });
  return grid;
}

test("a header's sort is read from the column header around its button", () => {
  const button = table([]).querySelector("button");
  button?.parentElement?.setAttribute("aria-sort", "descending");
  expect(button && shownSort(button)).toBe("descending");
});

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
    view: 0,
    total: 2,
    columns: [
      { name: "Name", kind: "string", priority: 0 },
      { name: "Namespace", kind: "string", priority: 0 },
    ],
    window: { start: 0, ids: ["b", "a"] },
    upserts: [
      {
        id: "a",
        created: null,
        received: "2026-11-16T12:00:00.000Z",
        generated: null,
        cells: ["api-1", "payments"],
      },
      {
        id: "b",
        created: null,
        received: "2026-11-16T12:00:00.000Z",
        generated: null,
        cells: ["api-2", "payments"],
      },
    ],
    status: { state: "ready" },
    counts: null,
    groups: null,
    metrics: null,
  });
  expect(topRows(list)).toEqual(["payments/api-2", "payments/api-1"]);
  list.record(1, {
    seq: 2,
    view: 0,
    total: 2,
    columns: null,
    window: { start: 1, ids: ["a", "b"] },
    upserts: [],
    status: { state: "ready" },
    counts: null,
    groups: null,
    metrics: null,
  });
  expect(topRows(list)).toBeUndefined();
});

function listed(view: number, ids: string[]): ListBatch {
  return {
    seq: view + 1,
    view,
    total: 2,
    columns: [
      { name: "Name", kind: "string", priority: 0 },
      { name: "Namespace", kind: "string", priority: 0 },
    ],
    window: { start: 0, ids },
    upserts: ["a", "b"].map((id) => ({
      id,
      created: null,
      received: "2026-11-16T12:00:00.000Z",
      generated: null,
      cells: [`api-${id}`, "payments"],
    })),
    status: { state: "ready" },
    counts: null,
    groups: null,
    metrics: null,
  };
}

test("a sort is answered by the batch that names its view, not by the rows an earlier view still sends", async () => {
  vi.useFakeTimers();
  try {
    const list = new ListProbe();
    list.record(0, listed(0, ["a", "b"]));
    let answered: string[] | undefined;
    const waiting = answer(list, 1, "rows").then((rows) => {
      answered = rows;
    });
    list.record(1, listed(0, ["b", "a"]));
    await vi.advanceTimersByTimeAsync(0);
    expect(answered, "the old view's churn").toBeUndefined();
    list.record(2, listed(1, ["b", "a"]));
    await waiting;
    expect(answered).toEqual(["payments/api-b", "payments/api-a"]);
  } finally {
    vi.useRealTimers();
  }
});

test("a view the list answered already is answered at once, and one it never answers times out", async () => {
  vi.useFakeTimers();
  try {
    const list = new ListProbe();
    list.record(0, listed(2, ["a", "b"]));
    await expect(answer(list, 1, "rows")).resolves.toEqual([
      "payments/api-a",
      "payments/api-b",
    ]);
    const never = expect(answer(list, 3, "rows of view 3")).rejects.toThrow(
      "no rows of view 3 within 5000 ms",
    );
    await vi.advanceTimersByTimeAsync(5000);
    await never;
  } finally {
    vi.useRealTimers();
  }
});
