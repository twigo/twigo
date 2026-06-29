import { useState, type CSSProperties, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

// Shared virtualized tree for the JetStream/KV/Object sidebar browsers: owns the
// (height-bounded) scroll container, the virtualizer, fixed-height absolutely-
// positioned rows, keyboard navigation and scroll-into-view. Each domain tree
// supplies a flat `rows` array, a row renderer, and what activate/expand/collapse
// mean for a row. The parent view must give this a bounded height (e.g. an
// `h-full min-h-0 flex-col` view) so the scroll container clips - otherwise the
// virtualizer can't window and scrollToIndex has nothing to scroll.
//
// The subject tree (no keyboard nav, ContextMenu rows, streaming-based selection)
// and the message table (a grid) are deliberately not built on this - different
// shapes, not the same abstraction.

const ROW_H = 26;

interface RowNav<T> {
  // Enter / double-click.
  onActivate: (row: T) => void;
  // true = expandable & open, false = expandable & collapsed, null = not expandable.
  expanded?: (row: T) => boolean | null;
  onExpand?: (row: T) => void;
  onCollapse?: (row: T) => void;
}

export function VirtualTree<T>({
  rows,
  rowKey,
  renderRow,
  nav,
  rowHeight = ROW_H,
}: {
  rows: T[];
  rowKey: (row: T, index: number) => string;
  // Inner row content (the visual row); `selected` reflects keyboard selection.
  renderRow: (row: T, selected: boolean) => ReactNode;
  // Omit for a static, non-navigable tree.
  nav?: RowNav<T>;
  rowHeight?: number;
}) {
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState(0);
  const sel = Math.min(selected, rows.length - 1);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  // Drive the scroll from the handler (a useEffect after setState can no-op, and
  // the native scroll is preventDefault'd, so it must scroll here).
  const moveTo = (next: number) => {
    setSelected(next);
    virtualizer.scrollToIndex(next);
  };

  const onKeyDown = nav
    ? (e: React.KeyboardEvent) => {
        const row = rows[sel];
        if (e.key === "ArrowDown") {
          e.preventDefault();
          moveTo(Math.min(sel + 1, rows.length - 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          moveTo(Math.max(sel - 1, 0));
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (row) nav.onActivate(row);
        } else if (
          e.key === "ArrowRight" &&
          row &&
          nav.expanded?.(row) === false
        ) {
          e.preventDefault();
          nav.onExpand?.(row);
        } else if (
          e.key === "ArrowLeft" &&
          row &&
          nav.expanded?.(row) === true
        ) {
          e.preventDefault();
          nav.onCollapse?.(row);
        }
      }
    : undefined;

  return (
    <div ref={setScrollEl} className="min-h-0 flex-1 overflow-y-auto">
      <ul
        role="tree"
        tabIndex={nav ? 0 : undefined}
        onKeyDown={onKeyDown}
        className="relative w-full py-0.5 outline-none"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((v) => {
          const row = rows[v.index];
          if (!row) return null;
          const i = v.index;
          const isSel = !!nav && i === sel;
          const style: CSSProperties = {
            height: v.size,
            transform: `translateY(${v.start.toString()}px)`,
          };
          return (
            <li
              key={rowKey(row, i)}
              role="treeitem"
              aria-selected={nav ? isSel : undefined}
              // null (not expandable) collapses to undefined via ??.
              aria-expanded={nav?.expanded?.(row) ?? undefined}
              onClick={nav ? () => setSelected(i) : undefined}
              onDoubleClick={nav ? () => nav.onActivate(row) : undefined}
              className="absolute left-0 top-0 w-full"
              style={style}
            >
              {renderRow(row, isSel)}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
