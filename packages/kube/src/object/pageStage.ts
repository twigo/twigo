import {
  useCallback,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import { CUT_PENDING } from "@twigo/ui";

/** The width of an object's own page from which it draws the full page: a wide action row, the sections open, and the property rows in two columns. */
export const FULL_PAGE = 900;

/** Spare width a fuller stage needs before it comes back, so that a width on a boundary does not flicker. */
export const MARGIN = 16;

/**
 * Draws `redraw` at the start of the next frame, before that frame's layout
 * and the delivery of its observers, so that the frame after the one that
 * reported a resize paints the stage its new width decides. A store change
 * would render inside the delivery that reported the resize and take along the
 * updates that `useWidth` has pending, which resize what lies above the
 * observer: Chrome then reports "ResizeObserver loop completed with undelivered
 * notifications". A plain update waits for React's scheduler, which leaves
 * frames at the old stage.
 */
function nextFrame(redraw: () => void) {
  const waiting = new Set<number>();
  return {
    schedule() {
      const frame = requestAnimationFrame(() => {
        waiting.delete(frame);
        flushSync(redraw);
      });
      waiting.add(frame);
    },
    cancel() {
      for (const frame of waiting) cancelAnimationFrame(frame);
      waiting.clear();
    },
  };
}

/**
 * An element's width, read as it is attached, in the render that follows, so
 * that what a stage decides never paints one stage first, and as it resizes, at
 * the start of the next frame (`nextFrame`). A width of 0 is no layout, as with
 * a tab that dockview detaches while another shows, and the width the element
 * had stays.
 */
export function useClientWidth(element: HTMLElement | null): number {
  const held = useRef<{ element: HTMLElement | null; width: number }>({
    element,
    width: 0,
  });
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  return useSyncExternalStore(
    useCallback(() => {
      if (!element) return () => undefined;
      const next = nextFrame(redraw);
      const observer = new ResizeObserver(() => {
        const width = element.clientWidth;
        if (width > 0 && width !== held.current.width) next.schedule();
      });
      observer.observe(element);
      return () => {
        observer.disconnect();
        next.cancel();
      };
    }, [element]),
    () => {
      if (held.current.element !== element)
        held.current = { element, width: 0 };
      const width = element?.clientWidth ?? 0;
      if (width > 0) held.current.width = width;
      return held.current.width;
    },
  );
}

/** The widths of a box's children, the array it was given when they are the same: a child that is not laid out keeps the width it had, and one that holds a cut waiting for its font is none measured, 0. */
function widthsOf(
  box: HTMLElement | null,
  was: readonly number[],
): readonly number[] {
  const read = [...(box?.children ?? [])].map((child, index) =>
    child.querySelector(`[${CUT_PENDING}]`) !== null
      ? 0
      : child.clientWidth > 0
        ? child.clientWidth
        : (was[index] ?? 0),
  );
  return read.length === was.length &&
    read.every((width, index) => width === was[index])
    ? was
    : read;
}

/**
 * The widths of an element's children, read as `useClientWidth` reads one: the
 * hidden copies of a part's stages, one child each. A child that is not laid
 * out keeps the width it had. A child that holds a text whose cut waits for its
 * font (`CUT_PENDING`) is none measured, 0, until the font is read: it would
 * count a name whole that its cut then shortens.
 * `content` names what the children draw: once it is another, they are all
 * none measured until the commit that draws it, since what they measure
 * before is the last content's.
 */
export function useChildWidths(
  box: HTMLElement | null,
  content: string,
): readonly number[] {
  const held = useRef<{
    box: HTMLElement | null;
    content: string;
    drawn: boolean;
    widths: readonly number[];
  }>({ box, content, drawn: true, widths: [] });
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  useLayoutEffect(() => {
    held.current.drawn = true;
  });
  return useSyncExternalStore(
    useCallback(
      (changed: () => void) => {
        if (!box) return () => undefined;
        const next = nextFrame(redraw);
        const observer = new ResizeObserver(() => {
          const { drawn, widths } = held.current;
          if (drawn && widthsOf(box, widths) !== widths) next.schedule();
        });
        for (const child of box.children) observer.observe(child);
        const pending = new MutationObserver(changed);
        pending.observe(box, {
          subtree: true,
          attributes: true,
          attributeFilter: [CUT_PENDING],
        });
        return () => {
          observer.disconnect();
          pending.disconnect();
          next.cancel();
        };
      },
      [box],
    ),
    () => {
      if (held.current.box !== box)
        held.current = { box, content, drawn: true, widths: [] };
      else if (held.current.content !== content)
        held.current = { box, content, drawn: false, widths: [] };
      if (held.current.drawn)
        held.current.widths = widthsOf(box, held.current.widths);
      return held.current.widths;
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

/**
 * Whether a stage that starts at `from` px is drawn at `width`, remembering
 * whether it was: it comes at `from` and stays down to the margin below it, so
 * that a width on the boundary does not flicker. A width of 0 is none measured,
 * and no stage stands on it, as a form that measures 0 fits nowhere.
 */
export function useHeld(width: number, from: number): boolean {
  const [drawn, setDrawn] = useState(false);
  const next = width > 0 && width >= (drawn ? from - MARGIN : from);
  if (next !== drawn) setDrawn(next);
  return next;
}
