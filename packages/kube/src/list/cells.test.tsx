import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { Column, Gvr, Row } from "@twigo/protocol";
import { columnRule } from "../columns";
import { PODS } from "../kinds";
import { CellView } from "./cells";

afterEach(cleanup);

const DEPLOYMENTS: Gvr = {
  group: "apps",
  version: "v1",
  resource: "deployments",
};
const JOBS: Gvr = { group: "batch", version: "v1", resource: "jobs" };
const SERVICES: Gvr = { group: "", version: "v1", resource: "services" };
const READY: Column = { name: "Ready", kind: "string", priority: 0 };

function ready(gvr: Gvr, text: string, tone: "error" | "warn" | undefined) {
  const row: Row = { id: "r", created: null, generated: null, cells: [text] };
  const column = { name: "Ready", index: 0, rule: columnRule(gvr, READY) };
  return render(<CellView row={row} column={column} tone={tone} />).container;
}

const warns = (container: HTMLElement) =>
  container.querySelector(".text-warn-foreground") !== null;

test("a pod's ready ratio short of its total is a warning, unless its status already carries the row's tone", () => {
  expect(warns(ready(PODS, "0/1", undefined))).toBe(true);
  cleanup();
  expect(warns(ready(PODS, "0/1", "error"))).toBe(false);
  cleanup();
  expect(warns(ready(PODS, "0/1", "warn"))).toBe(false);
  cleanup();
  expect(warns(ready(PODS, "1/1", undefined))).toBe(false);
});

test("a Deployment's ready ratio is its health column, so it stays a warning when the row has a tone", () => {
  expect(warns(ready(DEPLOYMENTS, "1/2", "warn"))).toBe(true);
});

function text(gvr: Gvr, column: Column, cell: string) {
  const row: Row = { id: "r", created: null, generated: null, cells: [cell] };
  const shown = { name: column.name, index: 0, rule: columnRule(gvr, column) };
  return render(<CellView row={row} column={shown} tone={undefined} />)
    .container;
}

const tabular = (container: HTMLElement) =>
  container.querySelector(".tabular-nums") !== null;

test("a cell of a column the server declares a string is tabular when its text is figures or addresses", () => {
  const column = (name: string): Column => ({
    name,
    kind: "string",
    priority: 0,
  });
  const cases: [Gvr, string, string, boolean][] = [
    [DEPLOYMENTS, "Up-to-date", "40", true],
    [DEPLOYMENTS, "Available", "35", true],
    [DEPLOYMENTS, "Up-to-date", "<none>", false],
    [JOBS, "Completions", "1/1", true],
    [JOBS, "Duration", "48s", true],
    [JOBS, "Duration", "2m6s", true],
    [SERVICES, "Cluster-IP", "10.96.0.1", true],
    [SERVICES, "External-IP", "203.0.113.7,203.0.113.8", true],
    [PODS, "Status", "Running", false],
    [PODS, "Node", "worker-1", false],
  ];
  for (const [gvr, name, cell, expected] of cases) {
    expect([name, cell, tabular(text(gvr, column(name), cell))]).toEqual([
      name,
      cell,
      expected,
    ]);
    cleanup();
  }
});
