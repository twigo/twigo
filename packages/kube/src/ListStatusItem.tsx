import { useEffect, useState, type ReactNode } from "react";
import type { ViewState } from "@twigo/protocol";
import { cn } from "@twigo/ui";
import { useChanges, useWorkbench } from "@twigo/workbench";
import type { Discovery } from "./discovery";
import { SHOWS_ROWS, stateLabel, type ListStatuses } from "./listStatus";
import type { ListFilters } from "./filters";
import { byHealth, HEALTH } from "./health";
import { statusColumn } from "./tones";
import { parseListUri } from "./uri";

/** A status-bar entry: a button with a hover, as VS Code's are. */
function Entry({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={!onClick}
      className="flex h-6 items-center gap-1.5 px-1.5 tabular-nums enabled:hover:bg-statusbar-foreground/10"
    >
      {children}
    </button>
  );
}

const CONNECTION: Readonly<
  Partial<Record<ViewState["state"], { dot: string; text: string }>>
> = {
  ready: { dot: "bg-ok", text: "Connected" },
  relisting: { dot: "bg-ok", text: "Connected" },
  stale: { dot: "bg-warn", text: "Reconnecting" },
  queued: { dot: "bg-warn", text: "Waiting" },
  connecting: { dot: "bg-warn", text: "Connecting" },
  syncing: { dot: "bg-warn", text: "Syncing" },
  forbidden: { dot: "bg-error", text: "Forbidden" },
  unauthorized: { dot: "bg-error", text: "Unauthorized" },
  error: { dot: "bg-error", text: "Unreachable" },
};

/**
 * The active space's cluster: its connection as the active list sees it,
 * and its Kubernetes version when the space has one context.
 */
export function ClusterStatusItem({
  statuses,
  discovery,
}: {
  statuses: ListStatuses;
  discovery: Discovery;
}) {
  const { spaces, editors } = useWorkbench();
  useChanges(spaces.changes);
  useChanges(editors.changes);
  useChanges(statuses.changes);
  const space = spaces.active;
  const [only, ...more] = space?.contexts ?? [];
  const context = more.length === 0 ? only?.name : undefined;
  const [version, setVersion] = useState<{ context: string; value: string }>();
  useEffect(() => {
    if (!context) return;
    let live = true;
    discovery.version(context).then(
      (value) => {
        if (live) setVersion({ context, value });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [discovery, context]);

  const active = editors.active;
  const list = active === undefined ? undefined : statuses.get(active);
  const connection = list && CONNECTION[list.status.state];
  const label = list && stateLabel(list.status);
  return (
    <div className="flex items-center">
      {connection && (
        <Entry label={label ?? connection.text}>
          <span
            aria-hidden
            className={cn("size-1.5 rounded-full", connection.dot)}
          />
          {connection.text}
          {label && list.status.state === "syncing" && (
            <span className="opacity-70">
              {label.replace(/^Loading · /, "")}
            </span>
          )}
        </Entry>
      )}
      {version && version.context === context && (
        <Entry label={`Kubernetes ${version.value}`}>{version.value}</Entry>
      )}
    </div>
  );
}

const ORDER = ["ok", "warn", "error"] as const;

/**
 * The active list's rows, and how many are healthy, pending or failing;
 * a click on a count shows only those rows.
 */
export function ListSummaryItem({
  statuses,
  filters,
}: {
  statuses: ListStatuses;
  filters: ListFilters;
}) {
  const { editors } = useWorkbench();
  useChanges(editors.changes);
  useChanges(statuses.changes);
  const active = editors.active;
  const list = active === undefined ? undefined : statuses.get(active);
  const input = active === undefined ? undefined : parseListUri(active);
  if (!active || !list || !input || !SHOWS_ROWS.has(list.status.state))
    return null;
  const column = statusColumn(input.gvr);
  const counts = column && byHealth(input.gvr, column, list.groups);
  return (
    <div className="flex items-center">
      <Entry
        label={`${list.total.toLocaleString("en")} ${list.title.toLowerCase()}`}
      >
        {list.total.toLocaleString("en")} {list.title.toLowerCase()}
      </Entry>
      {counts &&
        ORDER.filter((health) => counts[health].count > 0).map((health) => {
          const { count, values } = counts[health];
          return (
            <Entry
              key={health}
              label={`${count.toLocaleString("en")} ${HEALTH[health].name}: ${values
                .map((group) => group.value)
                .join(", ")}`}
              onClick={() => {
                filters.setHealth(active, health);
              }}
            >
              <span
                aria-hidden
                className={cn("size-1.5 rounded-full", HEALTH[health].dot)}
              />
              {count.toLocaleString("en")}
            </Entry>
          );
        })}
    </div>
  );
}
