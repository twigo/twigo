/** Where each row of a property list sits in two columns: rows fill a line left to right, and a stacked one takes the whole line, after which the next begins a new one. */
export function lineUp(
  stacked: readonly boolean[],
): ("left" | "right" | "full")[] {
  let right = false;
  return stacked.map((one) => {
    if (one) {
      right = false;
      return "full";
    }
    const side = right ? "right" : "left";
    right = !right;
    return side;
  });
}
