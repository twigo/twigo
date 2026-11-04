import { expect, test } from "vitest";
import { LogBuffer, type Kind } from "./buffer";

const line = (text: string): Kind => ({
  type: "line",
  pod: "web-1",
  container: "web",
  level: null,
  text,
  styles: [],
});

const judged = () => ({ passes: true, hits: 0 });

test("a place for an entry the bound dropped moves nothing, as Rust's place does", () => {
  const buffer = new LogBuffer({ entries: 2, bytes: 1 << 20 });
  const [first] = buffer.insert(
    [
      [10n, line("a")],
      [20n, line("b")],
      [30n, line("c")],
    ],
    judged,
  );
  buffer.bound(new Set());
  expect(first).toBeDefined();
  expect(buffer.place(first ?? 0, 10n, 5n)).toBe(false);
  expect(buffer.entries.map((entry) => [entry.id, entry.at])).toEqual([
    [2, 20n],
    [3, 30n],
  ]);
});
