import { expect, test } from "vitest";
import { shows, topRows } from "./driver";
import { ListProbe } from "./probe";

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
      { id: "a", created: null, generated: null, cells: ["api-1", "payments"] },
      { id: "b", created: null, generated: null, cells: ["api-2", "payments"] },
    ],
    status: { state: "ready" },
    counts: null,
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
    counts: null,
    groups: null,
  });
  expect(topRows(list)).toBeUndefined();
});
