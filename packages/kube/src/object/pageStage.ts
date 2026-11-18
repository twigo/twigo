import { useCallback, useRef, useState, useSyncExternalStore } from "react";

/** The width of an object's own page from which it draws the full page: a summary column that stays beside the main one. */
export const FULL_PAGE = 900;

/** The label column of the page's property rows, which `LABEL_COLUMN` sets. */
export const LABEL_WIDTH = 112;

/**
 * The width of the full page's main column from which its property rows run
 * in two columns: each takes its label column, a 12 px gap and 225 px for its
 * value, with the 24 px that the list keeps between the columns and the page's
 * 14 px of padding on each side.
 */
export const TWO_COLUMNS = 2 * (LABEL_WIDTH + 12 + 225) + 24 + 2 * 14;

export const MARGIN = 16;

/**
 * Whether a stage that starts at `from` px is drawn at `width`: it comes at
 * `from` and stays down to the margin below it, so that a width on the
 * boundary does not flicker. A width of 0 is none measured, and no stage
 * stands on it, as a form that measures 0 fits nowhere.
 */
export function stands(width: number, drawn: boolean, from: number): boolean {
  return width > 0 && width >= (drawn ? from - MARGIN : from);
}

/**
 * An element's width, read as it is attached and as it resizes, in the render
 * that follows, so that what a stage decides never paints one stage first. A
 * width of 0 is no layout, as with a tab that dockview detaches while another
 * shows, and the width the element had stays.
 */
export function useClientWidth(element: HTMLElement | null): number {
  const held = useRef<{ element: HTMLElement | null; width: number }>({
    element,
    width: 0,
  });
  return useSyncExternalStore(
    useCallback(
      (changed: () => void) => {
        if (!element) return () => undefined;
        const observer = new ResizeObserver(changed);
        observer.observe(element);
        return () => {
          observer.disconnect();
        };
      },
      [element],
    ),
    () => {
      if (held.current.element !== element)
        held.current = { element, width: 0 };
      const width = element?.clientWidth ?? 0;
      if (width > 0) held.current.width = width;
      return held.current.width;
    },
  );
}

/**
 * Whether a form whose natural width is `natural` fits in `room`, which it
 * comes back to only with the margin to spare. A form that measures 0 fits
 * nowhere, and is not counted as one that was drawn when it measures again.
 * The 0 is a hidden copy that unmounts and mounts again (the containers' while
 * the usage is not ready, the vitals' while the cell holds no share of a base),
 * not a hidden tab, which keeps its last width in `useClientWidth`.
 */
export function useFits(room: number, natural: number): boolean {
  return useHeld(natural > 0 ? room : 0, natural + MARGIN);
}

/** Whether a stage that starts at `from` px is drawn at `width`, remembering whether it was. */
export function useHeld(width: number, from: number): boolean {
  const [drawn, setDrawn] = useState(false);
  const next = stands(width, drawn, from);
  if (next !== drawn) setDrawn(next);
  return next;
}
