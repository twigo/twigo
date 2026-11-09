import { useEffect, type RefObject } from "react";
import type { Area } from "../editors/registry";
import { useWorkbench } from "../react";
import type { PanelState } from "../spaces/store";

/**
 * Keeps a part inert while the panel's state says it is off screen, since a
 * hidden or covered part loses its height and not its elements (allotment
 * 1.20.6), and Tab and a restored focus reach what nobody sees. The focus it
 * held goes to the active editor of `to` first: the browser would drop it to
 * the page, where no key does anything.
 *
 * It follows the store, not the render, because an editor that opens right
 * after it reveals an area focuses itself in that call, and an inert area
 * refuses the focus.
 */
export function useInertWhile(
  ref: RefObject<HTMLElement | null>,
  off: (panel: PanelState | undefined) => boolean,
  to: Area,
): void {
  const { spaces, editors } = useWorkbench();
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const apply = () => {
      const space = spaces.active;
      const hidden = off(space && spaces.state(space.id).parts.panel);
      if (hidden) editors.releaseFocus(element, to);
      element.toggleAttribute("inert", hidden);
    };
    apply();
    return spaces.changes.subscribe(apply);
  }, [spaces, editors, ref, off, to]);
}
