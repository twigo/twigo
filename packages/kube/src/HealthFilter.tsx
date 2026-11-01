import { cn } from "@twigo/ui";
import { useChanges } from "@twigo/workbench";
import type { ListFilters } from "./filters";
import { byHealth, HEALTH, healthValues, type Health } from "./health";
import { SHOWS_ROWS, type ListStatuses } from "./listStatus";
import { statusColumn } from "./tones";
import { parseListUri } from "./uri";

const ORDER = ["error", "warn", "ok"] as const;

/** All, or only the failing, pending or healthy rows of a list whose kind has a status column. */
export function HealthFilter({
  uri,
  filters,
  statuses,
}: {
  uri: string;
  filters: ListFilters;
  statuses: ListStatuses;
}) {
  useChanges(filters.changes);
  useChanges(statuses.changes);
  const input = parseListUri(uri);
  const list = statuses.get(uri);
  const column = input && statusColumn(input.gvr);
  if (!input || !column || !list || !SHOWS_ROWS.has(list.status.state))
    return null;
  const counts = byHealth(input.gvr, column, list.groups);
  const total = ORDER.reduce((sum, health) => sum + counts[health].count, 0);
  const picked = filters.health(uri)?.health;
  const chip = (
    health: Health | undefined,
    label: string,
    count: number,
    dot?: string,
  ) => (
    <button
      key={health ?? "all"}
      type="button"
      aria-pressed={picked === health}
      onClick={() => {
        filters.setHealth(
          uri,
          health && { health, values: healthValues(counts[health]) },
        );
      }}
      className={cn(
        "flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-row-hover hover:text-foreground",
        picked === health && "bg-foreground/10 text-foreground",
      )}
    >
      {dot && <span aria-hidden className={cn("size-1.5 rounded-full", dot)} />}
      {label}
      <span className="tabular-nums opacity-70">
        {count.toLocaleString("en")}
      </span>
    </button>
  );
  return (
    <div
      role="group"
      aria-label="Show rows"
      className="flex items-center gap-0.5"
    >
      {chip(undefined, "All", total)}
      {ORDER.map((health) =>
        chip(
          health,
          HEALTH[health].title,
          counts[health].count,
          HEALTH[health].dot,
        ),
      )}
    </div>
  );
}
