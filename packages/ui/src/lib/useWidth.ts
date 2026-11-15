import { useEffect, useState } from "react";

/**
 * An element's width as it lays out, 0 until it is first measured. An
 * element that measures 0 is not laid out, as a tab dockview detaches
 * while another shows, and keeps the width it had.
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
