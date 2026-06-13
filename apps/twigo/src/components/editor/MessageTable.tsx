import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@twigo/ui";
import {
  fmtTime,
  fmtDateTime,
  fmtBytes,
  type StreamMessage,
} from "@twigo/utils";

// Virtualized rows are absolutely positioned, which a real <table> can't host;
// fixed grid tracks keep columns aligned across independently-positioned rows.
const GRID = "grid grid-cols-[7rem_11rem_4rem_1fr] items-center";
const ROW_H = 24;

export function MessageTable({
  items,
  selectedId,
  onSelect,
  scrollEl,
}: {
  items: StreamMessage[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  // Element-in-state (not a ref): an ancestor's ref isn't attached yet when
  // this child's layout effect mounts the virtualizer, so a ref would observe
  // null until an unrelated re-render.
  scrollEl: HTMLDivElement | null;
}) {
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_H,
    overscan: 12,
    getItemKey: (i) => items[i]?.id ?? i,
  });

  return (
    <div role="table" aria-label="Messages" className="text-xs">
      <div role="rowgroup" className="sticky top-0 z-10 bg-panel">
        <div
          role="row"
          className={cn(
            GRID,
            "h-6 text-left font-medium text-muted-foreground [&>*]:px-2",
          )}
        >
          <span role="columnheader">Time</span>
          <span role="columnheader">Subject</span>
          <span role="columnheader" className="text-right">
            Size
          </span>
          <span role="columnheader">Payload</span>
        </div>
      </div>
      <div
        role="rowgroup"
        className="relative w-full font-mono"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((v) => {
          const m = items[v.index];
          if (!m) return null;
          return (
            <div
              key={v.key}
              role="row"
              tabIndex={0}
              onClick={() => onSelect(m.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(m.id);
                }
              }}
              className={cn(
                GRID,
                "absolute left-0 top-0 w-full cursor-pointer border-b border-border/50 hover:bg-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&>*]:px-2",
                m.id === selectedId && "bg-selected",
              )}
              style={{
                height: v.size,
                transform: `translateY(${v.start.toString()}px)`,
              }}
            >
              <span
                role="cell"
                className="tabular-nums text-muted-foreground-2"
                title={fmtDateTime(m.receivedAt)}
              >
                {fmtTime(m.receivedAt)}
              </span>
              <span role="cell" className="truncate text-brand">
                {m.subject}
              </span>
              <span
                role="cell"
                className="text-right tabular-nums text-muted-foreground-2"
              >
                {fmtBytes(m.size)}
              </span>
              <span role="cell" className="truncate text-muted-foreground">
                {m.preview}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
