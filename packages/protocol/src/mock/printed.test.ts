import { expect, test } from "vitest";
import type { Column, Gvr } from "../generated";
import CASES from "../printed-cases.json";
import { CRONJOB_COLUMNS, EVENT_COLUMNS, POD_COLUMNS } from "./fixtures";
import { keepsStamp, printedColumns } from "./printed";

test("a stamp dates a print as the shared cases say", () => {
  const wrong = CASES.cases.flatMap(
    ({ name, held, heldAt, printed, at, keeps }) =>
      keepsStamp(held, heldAt, printed, at) === keeps ? [] : [name],
  );
  expect(wrong).toEqual([]);
});

test("the columns that print a duration are known by their resource, or are dates", () => {
  const printing = (
    group: string,
    resource: string,
    columns: readonly Column[],
  ) =>
    printedColumns({ group, version: "v1", resource } satisfies Gvr, columns)
      .filter((column) => column.printsDuration === true)
      .map((column) => column.name);
  expect(printing("", "pods", POD_COLUMNS)).toEqual(["Restarts"]);
  expect(printing("batch", "cronjobs", CRONJOB_COLUMNS)).toEqual([
    "Last Schedule",
  ]);
  expect(printing("", "events", EVENT_COLUMNS)).toEqual([
    "Last Seen",
    "First Seen",
  ]);
  expect(printing("events.k8s.io", "events", EVENT_COLUMNS)).toEqual([
    "Last Seen",
    "First Seen",
  ]);
  expect(printing("example.com", "pods", POD_COLUMNS)).toEqual([]);
  expect(
    printing("example.com", "widgets", [
      { name: "Renewed", kind: "date", priority: 0 },
    ]),
  ).toEqual(["Renewed"]);
});
