export interface Place {
  readonly line: number;
  readonly column: number;
}

export interface Span {
  readonly start: Place;
  readonly end: Place;
}

export interface StatusBlock {
  readonly from: number;
  readonly to: number;
  readonly endColumn: number;
}

const before = (a: Place, b: Place): boolean =>
  a.line < b.line || (a.line === b.line && a.column < b.column);

/**
 * Whether typing or deleting at a selection would change the `status` block.
 * A cursor in the block or at either end of it does, and so does a selection
 * that overlaps it or starts at its end; a selection that ends where the block
 * begins, at column 1 of `status:`, does not when it starts at a column 1
 * too, since deleting whole lines leaves `status:` where it is, and does when
 * it starts in the middle of a line, since the rest of that line would join
 * `status:`.
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
  if (samePlace(end, first)) return start.column > 1;
  return !before(last, start) && before(first, end);
}

const samePlace = (a: Place, b: Place): boolean =>
  a.line === b.line && a.column === b.column;

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

/**
 * Whether typing or pasting over a selection would put its text onto
 * `status:`: the selection of whole lines that ends at column 1 of it, which
 * may be deleted but not replaced.
 */
export function gluesStatus(block: StatusBlock, { start, end }: Span): boolean {
  return before(start, end) && end.line === block.from && end.column === 1;
}

/** What a key does to the text of a selection that Monaco acts on after the key is read. */
export type StatusKey =
  "type" | "backwards" | "forwards" | "cut" | "moveDown" | "moveUp" | "join";

/**
 * Whether `key`, run at every selection, would change the `status` block: by
 * touching it, by joining a text to it, by gluing text onto it, or by moving
 * a line into it or out of it. Lines with nothing on them change nothing by
 * moving or joining. `type` stands for anything that replaces a selection.
 */
export function refusesStatus(
  block: StatusBlock,
  selections: readonly Span[],
  key: StatusKey,
  endOfLine: (line: number) => number,
): boolean {
  const emptyLines = (from: number, to: number): boolean => {
    for (let line = from; line <= to; line++) {
      if (endOfLine(line) > 1) return false;
    }
    return true;
  };
  return selections.some((selection) => {
    if (touchesStatus(block, selection)) return true;
    const { start, end } = selection;
    // Monaco leaves out the last line of a selection that ends at its column 1.
    const last =
      start.line < end.line && end.column === 1 ? end.line - 1 : end.line;
    switch (key) {
      case "type":
        return gluesStatus(block, selection);
      case "backwards":
      case "forwards":
        return !before(start, end) && joinsStatus(block, start, key, endOfLine);
      case "cut":
        return false;
      case "moveDown":
        return last + 1 === block.from && !emptyLines(start.line, last);
      case "moveUp":
        return start.line === block.to + 1 && !emptyLines(start.line, last);
      case "join": {
        // Joins the lines of the selection, or its line and the next.
        const through = start.line === end.line ? start.line + 1 : end.line;
        return (
          start.line < block.from &&
          through >= block.from &&
          !emptyLines(start.line, block.from - 1)
        );
      }
    }
  });
}
