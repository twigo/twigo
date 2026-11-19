import { expect, test } from "vitest";
import { lineCount } from "./lines";

test.each([
  ["", 1],
  ["a short line", 1],
  ["x".repeat(80), 1],
  ["x".repeat(81), 2],
  ["one\ntwo\nthree", 3],
  [`${"x".repeat(100)}\nshort`, 3],
  ["trailing\n", 2],
])("%j takes %d lines", (text, lines) => {
  expect(lineCount(text)).toBe(lines);
});
