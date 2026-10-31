import { MousePointerClick } from "lucide-react";
import { EmptyState } from "@twigo/ui";
import { humanDuration } from "@twigo/utils";
import { useChanges, useWorkbench } from "@twigo/workbench";
import { KindIcon } from "./KindIcon";
import type { Selection } from "./selection";
import { useNow } from "./useNow";

/**
 * The selected row's columns, wide ones included, without fetching the
 * object (ARCHITECTURE 4.3).
 */
export function Inspector({ selection }: { selection: Selection }) {
  const { spaces } = useWorkbench();
  useChanges(selection.changes);
  useChanges(spaces.changes);
  const now = useNow(1000);
  const space = spaces.active;
  const selected = space && selection.get(space.id);
  if (!selected) {
    return (
      <EmptyState
        icon={MousePointerClick}
        className="h-full"
        title="Nothing selected"
      >
        <p>Select a row to see it here.</p>
      </EmptyState>
    );
  }
  const { gvr, kind, columns, row } = selected;
  const name = columns.findIndex((column) => column.name === "Name");
  return (
    <div className="flex h-full flex-col overflow-auto px-3 pb-3 text-[13px]">
      <div className="flex items-center gap-1.5 py-2">
        <KindIcon gvr={gvr} className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">{kind}</span>
        <span className="truncate font-medium">
          {String(row.cells[name] ?? row.id)}
        </span>
      </div>
      <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-1">
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
    </div>
  );
}
