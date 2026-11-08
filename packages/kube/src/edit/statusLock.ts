/** A place in the text, 1-based as Monaco counts. */
export interface Place {
  readonly line: number;
  readonly column: number;
}

/** The selection of an editor, its start before its end. */
export interface Span {
  readonly start: Place;
  readonly end: Place;
}

/** The top-level `status`: its lines, inclusive, and the end of the last. */
export interface StatusBlock {
  readonly from: number;
  readonly to: number;
  /** The column after the last character of line `to`. */
  readonly endColumn: number;
}

const before = (a: Place, b: Place): boolean =>
  a.line < b.line || (a.line === b.line && a.column < b.column);

/**
 * Whether typing or deleting at a selection would change the `status` block.
 * A cursor in the block or at either end of it does, and so does a selection
 * that overlaps it or starts at its end; a selection that ends where the block
 * begins, at column 1 of `status:`, does not, since deleting it takes whole
 * lines above and leaves `status:` where it is.
 */
export function touchesStatus(
  block: StatusBlock,
  { start, end }: Span,
): boolean {
  const first: Place = { line: block.from, column: 1 };
  const last: Place = { line: block.to, column: block.endColumn };
  if (!before(start, end) && !before(end, start)) {
    return !before(start, first) && !before(last, start);
  }
  return !before(last, start) && before(first, end);
}

/**
 * Whether a key that deletes at an empty cursor would join a text to the
 * block, which no selection tells: Delete at the end of the line above
 * `status:` takes the line break before it, and Backspace at column 1 of the
 * line after the block takes the one after it. An empty line there is only
 * removed, and `status:` stays on a line of its own.
 */
export function joinsStatus(
  block: StatusBlock,
  caret: Place,
  direction: "backwards" | "forwards",
  endOfLine: (line: number) => number,
): boolean {
  if (direction === "backwards") {
    return (
      caret.line === block.to + 1 &&
      caret.column === 1 &&
      endOfLine(caret.line) > 1
    );
  }
  return (
    caret.line === block.from - 1 &&
    caret.line >= 1 &&
    caret.column > 1 &&
    caret.column === endOfLine(caret.line)
  );
}
