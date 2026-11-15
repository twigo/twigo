import { useEffect, type RefObject } from "react";
import type { Area } from "../editors/registry";
import { useWorkbench } from "../react";
import type { SideBar } from "../views/registry";
import { sideBarShown } from "./sideBarShown";

/**
 * Keeps a part inert while it is off screen: an area as the editor service
 * says (a hidden panel, an editor area under a maximized one), a side bar
 * that is hidden. A hidden or covered part loses its height and not its
 * elements (allotment 1.20.6), so Tab and a restored focus reach what nobody
 * sees. The focus it held goes to the active editor of the area the person
 * works in first: the browser would drop it to the page, where no key does
 * anything.
 *
 * It follows the store, not the render, because an editor that opens right
 * after it reveals an area focuses itself in that call, and an inert area
 * refuses the focus.
 */
export function useInertWhile(
  ref: RefObject<HTMLElement | null>,
  part: Area | SideBar,
): void {
  const workbench = useWorkbench();
  const { spaces, views, editors } = workbench;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const apply = () => {
      const hidden = !(part === "editor" || part === "panel"
        ? editors.onScreen(part)
        : sideBarShown(workbench, part));
      if (hidden) editors.releaseFocus(element);
      element.toggleAttribute("inert", hidden);
    };
    apply();
    const stops = [
      spaces.changes.subscribe(apply),
      views.changes.subscribe(apply),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, [workbench, spaces, views, editors, ref, part]);
}
