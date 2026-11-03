import { useId } from "react";
import { ArrowDown, ArrowUp, Check, Minus } from "lucide-react";
import { cn } from "../lib/cn";
import type { GridColumn, GridSort } from "./types";

import { MIN_WIDTH } from "./fit";

/**
 * A column's header: a click sorts by it, a second click reverses; its
 * right edge drags to resize, and a double click there fits the column
 * to what it shows.
 */
export function HeaderCell({
  column,
  width,
  sort,
  onSort,
  onResize,
  onFit,
}: {
  column: GridColumn;
  width: number;
  sort: GridSort | null;
  onSort: (sort: GridSort) => void;
  onResize: (width: number) => void;
  onFit: () => void;
}) {
  const title = useId();
  const active = sort?.column === column.id;
  const Arrow = active && sort.descending ? ArrowDown : ArrowUp;
  const end = column.align === "end";
  return (
    <div
      role="columnheader"
      aria-sort={
        active ? (sort.descending ? "descending" : "ascending") : "none"
      }
      // Its content would add the resize edge's label to its name.
      aria-labelledby={title}
      className="relative h-full border-r border-transparent group-hover/header:border-border-subtle"
    >
      <button
        type="button"
        onClick={() => {
          onSort({
            column: column.id,
            descending: active && !sort.descending,
          });
        }}
        className={cn(
          "flex h-full w-full items-center gap-1 px-2 text-left outline-none hover:text-foreground focus-visible:shadow-[inset_var(--focus-ring)]",
          end && "flex-row-reverse text-right",
          active && "text-foreground",
        )}
      >
        <span id={title} data-fit-header={column.id} className="truncate">
          {column.title}
        </span>
        {active && <Arrow aria-hidden className="size-3 shrink-0" />}
      </button>
      <span
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${column.title}`}
        onDoubleClick={onFit}
        onPointerDown={(event) => {
          if (event.detail > 1) return;
          event.preventDefault();
          const start = event.clientX;
          const target = event.currentTarget;
          // A growing column is wider on screen than its width.
          const from = Math.max(
            width,
            target.parentElement?.getBoundingClientRect().width ?? 0,
          );
          target.setPointerCapture(event.pointerId);
          const move = (next: PointerEvent) => {
            onResize(Math.max(MIN_WIDTH, from + next.clientX - start));
          };
          target.addEventListener("pointermove", move);
          target.addEventListener(
            "pointerup",
            () => {
              target.removeEventListener("pointermove", move);
            },
            { once: true },
          );
        }}
        className="absolute inset-y-0 -right-1.5 z-10 w-3 cursor-col-resize hover:bg-brand/30"
      />
    </div>
  );
}

/** A row's mark, or the header's, which clears every mark. */
export function MarkBox({
  checked,
  label,
  onToggle,
  partial = false,
}: {
  checked: boolean;
  label: string;
  onToggle: (shift: boolean) => void;
  partial?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={partial ? "mixed" : checked}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onToggle(event.shiftKey);
      }}
      className={cn(
        "flex size-3.5 items-center justify-center rounded-[4px] outline-none focus-visible:shadow-[var(--focus-ring)]",
        checked || partial
          ? "bg-brand text-brand-foreground"
          : "shadow-[inset_0_0_0_1px_var(--input)]",
      )}
    >
      {partial ? (
        <Minus aria-hidden className="size-3" />
      ) : (
        checked && <Check aria-hidden className="size-3" />
      )}
    </button>
  );
}
