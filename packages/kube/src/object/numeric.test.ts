import { expect, test } from "vitest";
import type { Value } from "@twigo/protocol";
import { isNumeric, numericColumns } from "./numeric";

const text = (value: string): Value => ({ type: "text", text: value });
const time: Value = { type: "time", at: "2026-11-03T11:36:41Z" };
const code = (value: string): Value => ({ type: "code", text: value });

test("a time is figures, a code or a link is not, and a list is when every item is", () => {
  expect(isNumeric(time)).toBe(true);
  expect(isNumeric(code("10.244.0.8"))).toBe(false);
  expect(isNumeric({ type: "list", items: [text("1"), text("2")] })).toBe(true);
  expect(isNumeric({ type: "list", items: [text("1"), text("a")] })).toBe(
    false,
  );
  expect(isNumeric({ type: "list", items: [] })).toBe(false);
});

test("a column of an Overview table is numeric when every cell that has something is figures", () => {
  const columns = [
    "Resource",
    "Capacity",
    "Requests",
    "Limits",
    "Note",
    "Created",
    "Empty",
  ];
  const rows = [
    [
      text("cpu"),
      text("16"),
      text("970m (6%)"),
      text("0 (0%)"),
      text("1"),
      time,
      text(""),
    ],
    [
      text("pods"),
      text("110"),
      text("17"),
      text(""),
      text("n/a"),
      time,
      text(""),
    ],
  ];
  expect(numericColumns(columns, rows)).toEqual([
    false,
    true,
    true,
    true,
    false,
    true,
    false,
  ]);
});
