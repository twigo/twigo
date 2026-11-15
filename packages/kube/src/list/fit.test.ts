import { expect, test } from "vitest";
import type { Column } from "@twigo/protocol";
import { columnRule } from "../columns";
import { PODS } from "../kinds";
import { leaving, type Leaver } from "./fit";

const column = (
  name: string,
  kind: Column["kind"] = "string",
  priority = 0,
): Column => ({ name, kind, priority });

const POD_COLUMNS: readonly Column[] = [
  column("Name"),
  column("Namespace"),
  column("Ready"),
  column("Status"),
  column("Restarts", "integer"),
  column("Node", "string", 1),
  column("CPU", "cpu"),
  column("Memory", "memory"),
  column("Age", "age"),
];

const leavers = (columns: readonly Column[]): Leaver[] =>
  columns
    .filter(({ name }) => name !== "Name")
    .map((each) => {
      const rule = columnRule(PODS, each);
      return {
        name: each.name,
        width: rule.width,
        drop: rule.drop,
        ...(rule.into && { into: rule.into }),
      };
    });

const NAME = columnRule(PODS, column("Name")).width;
const total = (columns: readonly Leaver[]) =>
  columns.reduce((sum, { width }) => sum + width, NAME);

test("a pod list gives up Node, Memory, CPU, Age, Namespace, Restarts, Ready and last Status as it narrows, and never Name", () => {
  const all = leavers(POD_COLUMNS);
  const order: string[] = [];
  for (let room = total(all); room >= 0; room--) {
    for (const name of leaving(NAME, all, room))
      if (!order.includes(name)) order.push(name);
  }
  expect(order).toEqual([
    "Node",
    "Memory",
    "CPU",
    "Age",
    "Namespace",
    "Restarts",
    "Ready",
    "Status",
  ]);
});

test("what is shown depends on the room alone: widening brings back the same columns, last gone first", () => {
  const all = leavers(POD_COLUMNS);
  const kept = (room: number) => {
    const gone = leaving(NAME, all, room);
    return all.filter(({ name }) => !gone.has(name)).map(({ name }) => name);
  };
  const rooms = Array.from({ length: 1200 }, (_, at) => at);
  const narrowing = rooms.map(kept);
  const widening = [...rooms].reverse().map(kept).reverse();
  expect(widening).toEqual(narrowing);
  for (let at = 1; at < narrowing.length; at++) {
    const before = narrowing[at - 1] ?? [];
    expect(narrowing[at]).toEqual(expect.arrayContaining(before));
  }
  expect(kept(total(all))).toEqual(all.map(({ name }) => name));
  expect(kept(total(all) - 1)).not.toContain("Node");
});

test("among columns of one rank the right-hand one goes first, and a column nobody ranked goes before every ranked one", () => {
  const all: Leaver[] = [
    { name: "a", width: 100, drop: 0 },
    { name: "b", width: 100, drop: 2 },
    { name: "c", width: 100, drop: 0 },
    { name: "d", width: 100, drop: 2 },
  ];
  expect([...leaving(0, all, 399)]).toEqual(["c"]);
  expect([...leaving(0, all, 299)]).toEqual(["c", "a"]);
  expect([...leaving(0, all, 199)]).toEqual(["c", "a", "d"]);
});

test("the fixed width counts, and a room that holds everything drops nothing", () => {
  const all = leavers(POD_COLUMNS);
  expect(leaving(NAME, all, total(all)).size).toBe(0);
  expect(leaving(NAME, all, Number.POSITIVE_INFINITY).size).toBe(0);
  expect(leaving(NAME + 500, all, total(all)).size).toBeGreaterThan(0);
});

test("a width the user dragged is the width a column takes", () => {
  const wide: Leaver[] = [
    { name: "Status", width: 400, drop: 8 },
    { name: "Age", width: 64, drop: 4 },
  ];
  expect([...leaving(160, wide, 600)]).toEqual(["Age"]);
  expect([...leaving(160, wide, 500)]).toEqual(["Age", "Status"]);
});

test("a column that goes into another leaves it the room for the value, and takes the room with it", () => {
  const ready: Leaver = {
    name: "Ready",
    width: 56,
    drop: 7,
    into: { column: "Status", room: 24 },
  };
  const status: Leaver = { name: "Status", width: 160, drop: 8 };
  expect(leaving(160, [ready, status], 376).size).toBe(0);
  expect([...leaving(160, [ready, status], 375)]).toEqual(["Ready"]);
  expect([...leaving(160, [ready, status], 344)]).toEqual(["Ready"]);
  expect([...leaving(160, [ready, status], 343)]).toEqual(["Ready", "Status"]);
  expect([...leaving(160, [ready], 200)]).toEqual(["Ready"]);
});
