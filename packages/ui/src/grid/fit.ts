export const MIN_WIDTH = 48;

/**
 * A cell's padding, and a header's, which also keeps room for the sort
 * arrow and the header's right border.
 */
const CELL_PADDING = 16;
const HEADER_PADDING = 33;

/**
 * The width that shows a column's header and every rendered cell whole.
 * It measures a copy of each cell's content and of the header's title laid
 * out at its natural width, free of the cell that cuts it, so a fit can
 * narrow a column as well as widen it and counts a cut name whole.
 */
export function fitWidth(grid: HTMLElement, column: string): number {
  const id = CSS.escape(column);
  const measured = [
    ...[...grid.querySelectorAll<HTMLElement>(`[data-fit="${id}"]`)].map(
      (content) => ({ copy: natural(content), padding: CELL_PADDING }),
    ),
    ...[...grid.querySelectorAll<HTMLElement>(`[data-fit-header="${id}"]`)].map(
      (title) => ({ copy: natural(title), padding: HEADER_PADDING }),
    ),
  ];
  let widest = MIN_WIDTH;
  for (const { copy, padding } of measured) {
    const { marginLeft, marginRight } = getComputedStyle(copy);
    const margins =
      (parseFloat(marginLeft) || 0) + (parseFloat(marginRight) || 0);
    widest = Math.max(
      widest,
      copy.getBoundingClientRect().width + margins + padding,
    );
  }
  for (const { copy } of measured) copy.remove();
  return Math.ceil(widest);
}

/** A hidden copy of `element` beside it, as wide as its content. */
function natural(element: HTMLElement): HTMLElement {
  const copy = element.cloneNode(true) as HTMLElement;
  Object.assign(copy.style, {
    position: "absolute",
    visibility: "hidden",
    width: "max-content",
    maxWidth: "none",
  });
  element.after(copy);
  return copy;
}
