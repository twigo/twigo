import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@twigo/ui";
import { humanDuration } from "@twigo/utils";
import { KindIcon } from "./KindIcon";
import type { Selected } from "./selection";
import { useNow } from "./useNow";

const MIN_WIDTH = 320;

/**
 * A row's details sliding in over its list from the right, as Lens's
 * drawer (ARCHITECTURE 4.3): every column, wide ones included, without a
 * GET. Its left edge resizes it.
 */
export function Details({
  selected,
  onClose,
}: {
  selected: Selected;
  onClose: () => void;
}) {
  const now = useNow(1000);
  const [width, setWidth] = useState(440);
  const { gvr, kind, columns, row } = selected;
  const name = columns.findIndex((column) => column.name === "Name");
  return (
    <aside
      aria-label={`${kind} details`}
      style={{ width }}
      className="absolute inset-y-0 right-0 z-10 flex max-w-[85%] animate-in flex-col border-l border-border bg-editor shadow-lg animation-duration-150 slide-in-from-right-8"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize details"
        onPointerDown={(event) => {
          event.preventDefault();
          const start = event.clientX;
          const from = width;
          const target = event.currentTarget;
          target.setPointerCapture(event.pointerId);
          const move = (next: PointerEvent) => {
            setWidth(Math.max(MIN_WIDTH, from + start - next.clientX));
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
        className="absolute inset-y-0 -left-1 w-2 cursor-col-resize"
      />
      <header className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border-subtle pr-1 pl-3 text-[13px]">
        <KindIcon gvr={gvr} className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">{kind}</span>
        <span className="truncate font-medium">
          {String(row.cells[name] ?? row.id)}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close details"
          className="ml-auto"
          onClick={onClose}
        >
          <X />
        </Button>
      </header>
      <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] content-start gap-x-3 gap-y-1 overflow-auto p-3 text-[13px]">
        {columns.map((column, index) => (
          <div key={column.name} className="contents">
            <dt className="text-muted-foreground">{column.name}</dt>
            <dd className="truncate tabular-nums">
              {column.kind === "age"
                ? row.created
                  ? humanDuration(now - Date.parse(row.created))
                  : ""
                : String(row.cells[index] ?? "")}
            </dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
