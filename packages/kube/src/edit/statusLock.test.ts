import { expect, test } from "vitest";
import {
  joinsStatus,
  touchesStatus,
  type Span,
  type StatusBlock,
} from "./statusLock";

const block: StatusBlock = { from: 3, to: 4, endColumn: 12 };
const at = (line: number, column: number) => ({ line, column });
const caret = (line: number, column: number): Span => ({
  start: at(line, column),
  end: at(line, column),
});
const range = (
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
): Span => ({ start: at(startLine, startColumn), end: at(endLine, endColumn) });

test("a cursor in the block or at either end of it touches it, a cursor outside does not", () => {
  expect(touchesStatus(block, caret(3, 1))).toBe(true);
  expect(touchesStatus(block, caret(3, 8))).toBe(true);
  expect(touchesStatus(block, caret(4, 12))).toBe(true);
  expect(touchesStatus(block, caret(2, 9))).toBe(false);
  expect(touchesStatus(block, caret(5, 1))).toBe(false);
});

test("a selection touches the block when it overlaps it or starts at its end, and not when it ends at column 1 of status", () => {
  expect(touchesStatus(block, range(1, 1, 3, 1))).toBe(false);
  expect(touchesStatus(block, range(2, 1, 3, 1))).toBe(false);
  expect(touchesStatus(block, range(2, 1, 3, 2))).toBe(true);
  expect(touchesStatus(block, range(1, 1, 5, 3))).toBe(true);
  expect(touchesStatus(block, range(3, 3, 3, 7))).toBe(true);
  expect(touchesStatus(block, range(4, 12, 5, 3))).toBe(true);
  expect(touchesStatus(block, range(5, 1, 5, 3))).toBe(false);
});

test("Delete at the end of the line above status and Backspace at column 1 of the line after it join a text to it", () => {
  const endOfLine = (line: number) => [0, 17, 9, 8, 12, 12][line] ?? 1;
  expect(joinsStatus(block, caret(2, 9).start, "forwards", endOfLine)).toBe(
    true,
  );
  expect(joinsStatus(block, caret(2, 8).start, "forwards", endOfLine)).toBe(
    false,
  );
  expect(joinsStatus(block, caret(2, 9).start, "backwards", endOfLine)).toBe(
    false,
  );
  expect(joinsStatus(block, caret(5, 1).start, "backwards", endOfLine)).toBe(
    true,
  );
  expect(joinsStatus(block, caret(5, 2).start, "backwards", endOfLine)).toBe(
    false,
  );
  expect(joinsStatus(block, caret(5, 1).start, "forwards", endOfLine)).toBe(
    false,
  );

  const empty = (line: number) => (line === 2 || line === 5 ? 1 : 12);
  expect(joinsStatus(block, caret(2, 1).start, "forwards", empty)).toBe(false);
  expect(joinsStatus(block, caret(5, 1).start, "backwards", empty)).toBe(false);

  const first: StatusBlock = { from: 1, to: 2, endColumn: 5 };
  expect(joinsStatus(first, caret(1, 1).start, "forwards", () => 1)).toBe(
    false,
  );
});
