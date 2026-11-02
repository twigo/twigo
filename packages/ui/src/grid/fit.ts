export const MIN_WIDTH = 48;

/** The width that shows every rendered cell of a column whole, header included. */
export function fitWidth(grid: HTMLElement, column: string): number {
  let widest = MIN_WIDTH;
  for (const cell of grid.querySelectorAll<HTMLElement>(
    `[data-column="${CSS.escape(column)}"]`,
  )) {
    widest = Math.max(widest, cell.scrollWidth);
  }
  return Math.ceil(widest) + 2;
}
