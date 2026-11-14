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
