import type { Value } from "@twigo/protocol";
import { isFigures } from "../tabular";

/** Whether a value is figures: a time, which is an age, or text, toned or not, that `isFigures`. */
export function isNumeric(value: Value): boolean {
  switch (value.type) {
    case "time":
      return true;
    case "text":
    case "toned":
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
