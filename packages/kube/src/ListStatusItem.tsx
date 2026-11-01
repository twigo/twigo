import { useEffect, useState, type ReactNode } from "react";
import type { GroupCount, Gvr, ViewState } from "@twigo/protocol";
import { cn } from "@twigo/ui";
import { useChanges, useWorkbench } from "@twigo/workbench";
import type { Discovery } from "./discovery";
import { SHOWS_ROWS, stateLabel, type ListStatuses } from "./listStatus";
import { cellTone, statusColumn, type Tone } from "./tones";
import { listUri, parseListUri } from "./uri";

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

const TONE: Readonly<Record<Tone | "ok", { dot: string; name: string }>> = {
  ok: { dot: "bg-ok", name: "healthy" },
  warn: { dot: "bg-warn", name: "pending" },
  error: { dot: "bg-error", name: "failing" },
};

/** The status column's values by tone: healthy, pending, failing. */
function byTone(gvr: Gvr, column: string, groups: readonly GroupCount[]) {
  const tones = new Map<Tone | "ok", GroupCount[]>();
  for (const group of groups) {
    const tone = cellTone(gvr, column, group.value) ?? "ok";
    tones.set(tone, [...(tones.get(tone) ?? []), group]);
  }
  return (["ok", "warn", "error"] as const).flatMap((tone) => {
    const values = tones.get(tone) ?? [];
    const count = values.reduce((sum, group) => sum + group.count, 0);
    return count > 0 ? [{ tone, count, values }] : [];
  });
}

/**
 * The active list's rows, and how many are healthy, pending or failing;
 * a click on a count filters the list to that status.
 */
export function ListSummaryItem({ statuses }: { statuses: ListStatuses }) {
  const { editors, quickAccess } = useWorkbench();
  useChanges(editors.changes);
  useChanges(statuses.changes);
  const active = editors.active;
  const list = active === undefined ? undefined : statuses.get(active);
  const input = active === undefined ? undefined : parseListUri(active);
  if (!list || !input || !SHOWS_ROWS.has(list.status.state)) return null;
  const column = statusColumn(input.gvr);
  const tones = column ? byTone(input.gvr, column, list.groups) : [];
  const filter = (value: string) => {
    editors.open(listUri({ ...input, text: value }), { preview: true });
  };
  return (
    <div className="flex items-center">
      <Entry
        label={`${list.total.toLocaleString("en")} ${list.title.toLowerCase()}`}
      >
        {list.total.toLocaleString("en")} {list.title.toLowerCase()}
      </Entry>
      {tones.map(({ tone, count, values }) => (
        <Entry
          key={tone}
          label={`${count.toLocaleString("en")} ${TONE[tone].name}: ${values
            .map((group) => group.value)
            .join(", ")}`}
          onClick={() => {
            const [one, ...others] = values;
            if (one && others.length === 0) {
              filter(one.value);
              return;
            }
            void quickAccess
              .pick(
                `Show ${TONE[tone].name} ${list.title.toLowerCase()}`,
                values.map((group) => ({
                  id: group.value,
                  label: group.value,
                  description: group.count.toLocaleString("en"),
                })),
              )
              .then((picked) => {
                if (picked) filter(picked.id);
              });
          }}
        >
          <span
            aria-hidden
            className={cn("size-1.5 rounded-full", TONE[tone].dot)}
          />
          {count.toLocaleString("en")}
        </Entry>
      ))}
    </div>
  );
}
