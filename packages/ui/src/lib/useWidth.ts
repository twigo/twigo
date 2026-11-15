import { useEffect, useState } from "react";

/**
 * An element's width as it lays out, 0 until it is first measured. A
 * measure of 0 is taken as not laid out, as with a tab dockview detaches
 * while another shows, and the width it had stays.
 */
export function useWidth(element: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const measured = entry ? Math.round(entry.contentRect.width) : 0;
      if (measured > 0) setWidth(measured);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [element]);
  return width;
}
