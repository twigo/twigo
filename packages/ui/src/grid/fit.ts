export const MIN_WIDTH = 48;

/** A cell's padding, and a header's, which also keeps room for the sort arrow. */
const CELL_PADDING = 16;
const HEADER_PADDING = 32;

/**
 * The width that shows a column's header and every rendered cell whole.
 * It measures their content, not the cells, so a fit can narrow a column
 * as well as widen it: an inline span's box is its text's width, and a
 * truncated title's scroll width is the whole title.
 */
export function fitWidth(grid: HTMLElement, column: string): number {
  const id = CSS.escape(column);
  let widest = MIN_WIDTH;
  for (const content of grid.querySelectorAll<HTMLElement>(
    `[data-fit="${id}"]`,
  )) {
    widest = Math.max(
      widest,
      content.getBoundingClientRect().width + CELL_PADDING,
    );
  }
  for (const title of grid.querySelectorAll<HTMLElement>(
    `[data-fit-header="${id}"]`,
  )) {
    widest = Math.max(widest, title.scrollWidth + HEADER_PADDING);
  }
  return Math.ceil(widest);
}
