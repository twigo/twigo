import { useRef, useState } from "react";
import { cn } from "@twigo/ui";
import { clampInspectorWidth, KEY_STEP } from "./inspectorWidth";

/**
 * Main content plus a right inspector of a fixed pixel width, split by a drag
 * handle.
 *
 * Deliberately flex and not a split view: the only rule is "the inspector keeps
 * its width, the main pane takes the rest", which CSS applies on its own. A
 * layout algorithm has to recompute both panes whenever the window or the
 * sidebar moves, and allotment's non-proportional path does that in two passes
 * that disagree - which showed up as the boundary twitching mid-drag.
 */
export function InspectorSplit({
  main,
  inspector,
  inspectorVisible,
  defaultWidth,
}: {
  main: React.ReactNode;
  inspector: React.ReactNode;
  inspectorVisible: boolean;
  defaultWidth: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(defaultWidth);
  const [dragging, setDragging] = useState(false);

  const resizeTo = (clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setWidth(clampInspectorWidth(rect.right - clientX, rect.width));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step =
      e.key === "ArrowLeft" ? KEY_STEP : e.key === "ArrowRight" ? -KEY_STEP : 0;
    if (step === 0) return;
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    setWidth((w) => clampInspectorWidth(w + step, rect?.width ?? w + step));
  };

  return (
    <div ref={containerRef} className="flex min-h-0 min-w-0 flex-1">
      <div className={cn("min-w-0 flex-1", dragging && "select-none")}>
        {main}
      </div>
      {inspectorVisible && (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the inspector"
            tabIndex={0}
            onKeyDown={onKeyDown}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              setDragging(true);
            }}
            onPointerMove={(e) => {
              if (dragging) resizeTo(e.clientX);
            }}
            onPointerUp={(e) => {
              e.currentTarget.releasePointerCapture(e.pointerId);
              setDragging(false);
            }}
            className={cn(
              "relative w-px shrink-0 cursor-col-resize bg-border outline-none",
              "after:absolute after:inset-y-0 after:-left-1 after:-right-1 after:content-['']",
              "hover:bg-brand focus-visible:bg-brand",
              dragging && "bg-brand",
            )}
          />
          {/* Percentage cap, so a narrow window squeezes the inspector instead
              of starving the table - without measuring anything. */}
          <div
            style={{ width, maxWidth: "70%" }}
            className={cn("shrink-0", dragging && "select-none")}
          >
            {inspector}
          </div>
        </>
      )}
    </div>
  );
}
