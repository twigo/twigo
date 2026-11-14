import type { Value } from "@twigo/protocol";

const NUMBER = String.raw`\d+(?:\.\d+)?`;
const FIGURES = new RegExp(
  String.raw`^(?:${NUMBER} ?[A-Za-z]{0,2}(?: \(${NUMBER}%\))?|\d+/\d+)$`,
);

/** Whether text is a count, a quantity with or without its share (`970m (6%)`), or a ratio (`2/2`). */
export function isFigures(text: string): boolean {
  return FIGURES.test(text);
}

/** Whether a value is figures: a time, which is an age, or text that `isFigures`. */
export function isNumeric(value: Value): boolean {
  switch (value.type) {
    case "time":
      return true;
    case "text":
      return isFigures(value.text);
    case "list":
      return value.items.length > 0 && value.items.every(isNumeric);
    default:
      return false;
  }
}

/**
 * Which columns of an Overview table hold figures, as Rust sends no column
 * type: every cell is numeric, an empty one aside, and one at least is not
 * empty.
 */
export function numericColumns(
  columns: readonly string[],
  rows: readonly (readonly Value[])[],
): boolean[] {
  return columns.map((_, at) => {
    const cells = rows
      .map((row) => row[at])
      .filter(
        (cell): cell is Value =>
          cell !== undefined && !(cell.type === "text" && cell.text === ""),
      );
    return cells.length > 0 && cells.every(isNumeric);
  });
}
