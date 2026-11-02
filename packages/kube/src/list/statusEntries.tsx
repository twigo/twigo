import { useEffect, useState } from "react";
import type { ViewState } from "@twigo/protocol";
import type { Tone } from "@twigo/ui";
import { useChanges, useWorkbench, type StatusEntry } from "@twigo/workbench";
import type { Discovery } from "../discovery";
import {
  byHealth,
  HEALTH,
  healthValues,
  statusColumn,
  type Health,
} from "../columns";
import type { ListServices } from "../services";
import { parseListUri } from "../uri";
import { SHOWS_ROWS, stateLabel, type ListStatuses } from "./listStatus";

const CONNECTION: Readonly<
  Partial<Record<ViewState["state"], { tone: Tone; text: string }>>
> = {
  ready: { tone: "ok", text: "Connected" },
  relisting: { tone: "ok", text: "Connected" },
  stale: { tone: "warn", text: "Reconnecting" },
  queued: { tone: "warn", text: "Waiting" },
  connecting: { tone: "warn", text: "Connecting" },
  syncing: { tone: "warn", text: "Syncing" },
  forbidden: { tone: "error", text: "Forbidden" },
  unauthorized: { tone: "error", text: "Unauthorized" },
  error: { tone: "error", text: "Unreachable" },
};

/**
 * The active space's cluster after the space's own entry: its connection
 * as the active list sees it, and its Kubernetes version when the space
 * has one context. While connected only the version shows; otherwise the
 * state says itself in words.
 */
export function clusterEntries(
  statuses: ListStatuses,
  discovery: Discovery,
): () => readonly StatusEntry[] {
  return function useClusterEntries() {
    const { spaces, editors, credentials } = useWorkbench();
    useChanges(spaces.changes);
    useChanges(editors.changes);
    useChanges(statuses.changes);
    useChanges(credentials.changes);
    // The version is asked again once the context's credential comes.
    const { ready } = credentials;
    const [only, ...more] = spaces.active?.contexts ?? [];
    const context = more.length === 0 ? only : undefined;
    const [version, setVersion] = useState<{
      context: string;
      value: string;
    }>();
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
    }, [context, ready]);

    const active = editors.active;
    const list = active === undefined ? undefined : statuses.get(active);
    const connection = list && CONNECTION[list.status.state];
    const known =
      version !== undefined && version.context === context
        ? version.value
        : undefined;
    if (!connection && !known) return [];
    const healthy = !connection || connection.tone === "ok";
    return [
      {
        id: "cluster",
        text:
          healthy && known
            ? known
            : ((list && stateLabel(list.status)) ?? connection?.text ?? ""),
        ...(connection && { tone: connection.tone }),
        tooltip: [connection?.text, known && `Kubernetes ${known}`]
          .filter(Boolean)
          .join(" · "),
      },
    ];
  };
}

const ORDER: readonly Health[] = ["error", "warn"];

/**
 * The active list's rows, and how many fail or wait (ARCHITECTURE 4.1); a
 * click on a count shows only those rows.
 */
export function listEntries({
  statuses,
  states,
}: Pick<ListServices, "statuses" | "states">): () => readonly StatusEntry[] {
  return function useListEntries() {
    const { editors } = useWorkbench();
    useChanges(editors.changes);
    useChanges(statuses.changes);
    const active = editors.active;
    const list = active === undefined ? undefined : statuses.get(active);
    const input = active === undefined ? undefined : parseListUri(active);
    if (!active || !list || !input || !SHOWS_ROWS.has(list.status.state))
      return [];
    const column = statusColumn(input.gvr);
    const counts = column && byHealth(input.gvr, column, list.counts);
    const total = list.total.toLocaleString("en");
    return [
      { id: "rows", text: `${total} ${list.title.toLowerCase()}` },
      ...(counts
        ? ORDER.filter((health) => counts[health].count > 0).map(
            (health): StatusEntry => ({
              id: health,
              text: `${counts[health].count.toLocaleString("en")} ${HEALTH[health].name}`,
              tone: health === "error" ? "error" : "warn",
              tooltip: counts[health].values
                .map((value) => value.value)
                .join(", "),
              run: () => {
                states.setHealth(active, {
                  health,
                  values: healthValues(counts[health]),
                });
              },
            }),
          )
        : []),
    ];
  };
}
