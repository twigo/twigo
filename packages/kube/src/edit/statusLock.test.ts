import { expect, test } from "vitest";
import {
  gluesStatus,
  joinsStatus,
  refusesStatus,
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

test("a selection that starts in the middle of a line and ends at column 1 of status touches it, since deleting it joins the rest of that line to status", () => {
  expect(touchesStatus(block, range(2, 3, 3, 1))).toBe(true);
  expect(touchesStatus(block, range(1, 5, 3, 1))).toBe(true);
  expect(touchesStatus(block, range(2, 1, 3, 1))).toBe(false);
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

test("whole lines that end at column 1 of status can be deleted but not typed or pasted over", () => {
  expect(gluesStatus(block, range(2, 1, 3, 1))).toBe(true);
  expect(gluesStatus(block, range(1, 1, 3, 1))).toBe(true);
  expect(gluesStatus(block, caret(3, 1))).toBe(false);
  expect(gluesStatus(block, range(2, 1, 2, 9))).toBe(false);
  expect(gluesStatus(block, range(2, 1, 3, 2))).toBe(false);

  const endOfLine = () => 9;
  const whole = [range(1, 1, 3, 1)];
  expect(refusesStatus(block, whole, "type", endOfLine)).toBe(true);
  for (const key of ["backwards", "forwards", "cut"] as const) {
    expect(refusesStatus(block, whole, key, endOfLine), key).toBe(false);
  }
  expect(refusesStatus(block, [range(2, 4, 3, 1)], "cut", endOfLine)).toBe(
    true,
  );
});

test("a line moved down from above status or up from below the block changes it, and a line with nothing on it does not", () => {
  const endOfLine = (line: number) => [0, 17, 9, 8, 12, 12, 7][line] ?? 1;
  const refused = (key: "moveDown" | "moveUp", ...spans: Span[]) =>
    refusesStatus(block, spans, key, endOfLine);

  expect(refused("moveDown", caret(2, 4))).toBe(true);
  expect(refused("moveDown", caret(1, 4))).toBe(false);
  expect(refused("moveDown", range(1, 3, 2, 5))).toBe(true);
  expect(refused("moveDown", range(1, 1, 3, 1))).toBe(true);
  expect(refused("moveDown", range(1, 1, 2, 1))).toBe(false);
  expect(refused("moveDown", caret(5, 1))).toBe(false);
  expect(refused("moveDown", caret(4, 3))).toBe(true);

  expect(refused("moveUp", caret(5, 4))).toBe(true);
  expect(refused("moveUp", range(5, 1, 6, 3))).toBe(true);
  expect(refused("moveUp", caret(6, 4))).toBe(false);
  expect(refused("moveUp", caret(2, 4))).toBe(false);
  expect(refused("moveUp", caret(3, 2))).toBe(true);

  const blank = (line: number) => (line === 2 || line === 5 ? 1 : 12);
  expect(refusesStatus(block, [caret(2, 1)], "moveDown", blank)).toBe(false);
  expect(refusesStatus(block, [caret(5, 1)], "moveUp", blank)).toBe(false);
});

test("joining the line above status, or a selection that reaches it, joins a text to it", () => {
  const endOfLine = (line: number) => [0, 17, 9, 8, 12, 12][line] ?? 1;
  const refused = (...spans: Span[]) =>
    refusesStatus(block, spans, "join", endOfLine);
  expect(refused(caret(2, 3))).toBe(true);
  expect(refused(caret(1, 3))).toBe(false);
  expect(refused(range(1, 3, 3, 1))).toBe(true);
  expect(refused(range(1, 3, 2, 4))).toBe(false);
  expect(refused(range(2, 2, 2, 5))).toBe(true);
  expect(refused(caret(5, 1))).toBe(false);
  expect(refused(caret(4, 2))).toBe(true);

  const blank = (line: number) => (line === 2 ? 1 : 12);
  expect(refusesStatus(block, [caret(2, 1)], "join", blank)).toBe(false);
  expect(refusesStatus(block, [caret(1, 2)], "join", blank)).toBe(false);
});

test("every cursor counts, not the primary one alone", () => {
  const endOfLine = (line: number) => [0, 17, 9, 8, 12, 12][line] ?? 1;
  const elsewhere = caret(1, 2);
  expect(
    refusesStatus(block, [elsewhere, caret(2, 9)], "forwards", endOfLine),
  ).toBe(true);
  expect(
    refusesStatus(block, [caret(2, 9), elsewhere], "forwards", endOfLine),
  ).toBe(true);
  expect(
    refusesStatus(block, [elsewhere, caret(5, 1)], "backwards", endOfLine),
  ).toBe(true);
  expect(
    refusesStatus(block, [elsewhere, caret(5, 1)], "forwards", endOfLine),
  ).toBe(false);
  expect(
    refusesStatus(block, [elsewhere, caret(2, 3)], "moveDown", endOfLine),
  ).toBe(true);
  expect(
    refusesStatus(block, [elsewhere, caret(1, 5)], "moveDown", endOfLine),
  ).toBe(false);
});
