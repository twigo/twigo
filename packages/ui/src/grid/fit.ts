export const MIN_WIDTH = 48;

/**
 * A cell's padding, and a header's, which also keeps room for the sort
 * arrow and the header's right border.
 */
const CELL_PADDING = 16;
const HEADER_PADDING = 33;

/**
 * The width that shows a column's header and every rendered cell whole.
 * It measures each cell's content as a copy laid out at its natural width,
 * free of the cell, which cuts it, so a fit can narrow a column as well as
 * widen it and counts a cut name whole; a truncated title's scroll width
 * is the whole title.
 */
export function fitWidth(grid: HTMLElement, column: string): number {
  const id = CSS.escape(column);
  const copies = [
    ...grid.querySelectorAll<HTMLElement>(`[data-fit="${id}"]`),
  ].map((content) => {
    const copy = content.cloneNode(true) as HTMLElement;
    Object.assign(copy.style, {
      position: "absolute",
      visibility: "hidden",
      width: "max-content",
      maxWidth: "none",
    });
    content.after(copy);
    return copy;
  });
  let widest = MIN_WIDTH;
  for (const copy of copies) {
    const { marginLeft, marginRight } = getComputedStyle(copy);
    const margins =
      (parseFloat(marginLeft) || 0) + (parseFloat(marginRight) || 0);
    widest = Math.max(
      widest,
      copy.getBoundingClientRect().width + margins + CELL_PADDING,
    );
  }
  for (const copy of copies) copy.remove();
  for (const title of grid.querySelectorAll<HTMLElement>(
    `[data-fit-header="${id}"]`,
  )) {
    widest = Math.max(widest, title.scrollWidth + HEADER_PADDING);
  }
  return Math.ceil(widest);
}
