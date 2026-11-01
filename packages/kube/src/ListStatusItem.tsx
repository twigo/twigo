import { useChanges, useWorkbench } from "@twigo/workbench";
import { SHOWS_ROWS, stateLabel, type ListStatuses } from "./listStatus";

/** The active list's count and state, as VS Code puts an editor's facts in its status bar. */
export function ListStatusItem({ statuses }: { statuses: ListStatuses }) {
  const { editors } = useWorkbench();
  useChanges(editors.changes);
  useChanges(statuses.changes);
  const active = editors.active;
  const list = active === undefined ? undefined : statuses.get(active);
  if (!list) return null;
  const label = stateLabel(list.status);
  return (
    <span className="flex items-center gap-2 tabular-nums">
      {SHOWS_ROWS.has(list.status.state) && (
        <span>
          {list.total.toLocaleString("en")} {list.title.toLowerCase()}
        </span>
      )}
      {label && (
        <span
          className={list.status.state === "stale" ? "text-warn" : undefined}
        >
          {label}
        </span>
      )}
    </span>
  );
}
