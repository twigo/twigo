import {
  leastReady,
  readiness,
  SHOWS_ROWS,
  type Parts,
  type PartState,
  type ViewState,
} from "@twigo/protocol";
import type { Tone } from "@twigo/ui";
import { useChanges, useWorkbench, type StatusEntry } from "@twigo/workbench";
import { sameGvr, useClusterVersion, type Discovery } from "../discovery";
import {
  byHealth,
  HEALTH,
  healthValues,
  statusColumn,
  type Health,
} from "../columns";
import type { ListServices } from "../services";
import { parseListUri } from "../uri";
import { stateLabel, type ListStatus, type ListStatuses } from "./listStatus";

const CONNECTION: Readonly<
  Record<ViewState["state"], { tone: Tone; text: string }>
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

const LOADING: ReadonlySet<ViewState["state"]> = new Set([
  "connecting",
  "syncing",
]);

const TOOLTIP_NAMES = 6;

export interface PartsLine {
  readonly text: string;
  readonly tone: Tone;
  readonly tooltip: string;
}

interface Kind {
  readonly state: ViewState;
  readonly shown: boolean;
  readonly parts: PartState[];
}

/**
 * The words of the least ready part and how many of the parts are in that
 * state, connecting and syncing ones counting as one, loading, with each kind
 * of trouble in the tooltip, the worst first; none for a list of one part,
 * which its own state says.
 */
export function partsLine({
  count,
  unready: sent,
}: Parts): PartsLine | undefined {
  if (count < 2 || sent.length === 0) return undefined;
  const unready = sent.map(asSeen);
  const worst = leastReady(unready.map(({ state }) => state));
  const kinds = new Map<string, Kind>();
  for (const part of unready) {
    const key = JSON.stringify([
      part.state.state === "syncing" ? "syncing" : part.state,
      part.shown,
    ]);
    const kind = kinds.get(key) ?? {
      state: part.state,
      shown: part.shown,
      parts: [],
    };
    kind.parts.push(part);
    kinds.set(key, kind);
  }
  const loading = LOADING.has(worst.state);
  const alike = unready.filter(({ state }) =>
    loading ? LOADING.has(state.state) : state.state === worst.state,
  );
  const syncing = alike.flatMap(({ state }) =>
    state.state === "syncing" ? [state] : [],
  );
  const said = syncing.length > 0 ? leastReady(syncing) : worst;
  const { text, tone } = CONNECTION[worst.state];
  return {
    text: `${stateLabel(said) ?? text} · ${alike.length} of ${count} namespaces`,
    tone,
    tooltip: [...kinds.values()]
      .sort((a, b) => readiness(b.state) - readiness(a.state))
      .map(describe)
      .join("\n"),
  };
}

/** A part whose first list broke off holds no rows: it is connecting again, as Rust says of a list that shows none. */
function asSeen(part: PartState): PartState {
  return part.state.state === "stale" && !part.shown
    ? { ...part, state: { state: "connecting" } }
    : part;
}

function describe({ state, shown, parts }: Kind): string {
  const where = namesOf(parts, state.state === "syncing");
  switch (state.state) {
    case "forbidden":
      return `May not ${state.verb} ${state.resource} in ${where}`;
    case "unauthorized":
      return `${where}: the cluster rejected the credentials`;
    case "error":
      return `${where}: ${state.error.message}`;
    case "queued":
      return `${where}: ${shown ? "rows as last listed" : "no rows yet"}`;
    case "connecting":
      return `${where}: connecting`;
    case "syncing":
      return `${where}: loading`;
    case "stale":
      return `${where}: no updates, reconnecting`;
    case "relisting":
      return `${where}: relisting`;
    case "ready":
      return where;
  }
}

/** Parts by name, the first few; a part of a kind this webview does not know is counted and not named. */
function namesOf(parts: readonly PartState[], loaded: boolean): string {
  const named = parts.flatMap(({ part, state }) =>
    part.kind !== "namespace"
      ? []
      : [
          loaded && state.state === "syncing"
            ? `${part.name} (${state.loaded.toLocaleString("en")})`
            : part.name,
        ],
  );
  const head = named.slice(0, TOOLTIP_NAMES).join(", ");
  const rest = parts.length - Math.min(named.length, TOOLTIP_NAMES);
  if (rest === 0) return head;
  if (head !== "") return `${head} and ${rest} more`;
  return `${rest} ${rest === 1 ? "part" : "parts"}`;
}

/**
 * What the cluster entry says of a list: its status, but for a list of one
 * part whose rows are shown, that part's own state, as the status calls a part
 * that waits for a stream slot after its list `stale`.
 */
function spoken({ status, parts }: ListStatus): ViewState {
  const [only] = parts.unready;
  return parts.count === 1 && only?.shown ? only.state : status;
}

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
    const { spaces, editors } = useWorkbench();
    useChanges(spaces.changes);
    useChanges(editors.changes);
    useChanges(statuses.changes);
    const [only, ...more] = spaces.active?.contexts ?? [];
    const known = useClusterVersion(
      discovery,
      more.length === 0 ? only : undefined,
    );

    const active = editors.active;
    const list = active === undefined ? undefined : statuses.get(active);
    const line = list && partsLine(list.parts);
    if (line) {
      return [
        {
          id: "cluster",
          text: line.text,
          tone: line.tone,
          tooltip: [line.tooltip, known && `Kubernetes ${known}`]
            .filter(Boolean)
            .join("\n"),
        },
      ];
    }
    const state = list && spoken(list);
    const connection = state && CONNECTION[state.state];
    if (!connection && !known) return [];
    const healthy = !connection || connection.tone === "ok";
    return [
      {
        id: "cluster",
        text:
          healthy && known
            ? known
            : ((state && stateLabel(state)) ?? connection?.text ?? ""),
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
  discovery,
}: Pick<
  ListServices,
  "statuses" | "states" | "discovery"
>): () => readonly StatusEntry[] {
  return function useListEntries() {
    const { editors } = useWorkbench();
    useChanges(editors.changes);
    useChanges(statuses.changes);
    useChanges(discovery.changes);
    const active = editors.active;
    const list = active === undefined ? undefined : statuses.get(active);
    const input = active === undefined ? undefined : parseListUri(active);
    if (!active || !list || !input || !SHOWS_ROWS.has(list.status.state))
      return [];
    const column = statusColumn(input.gvr);
    const counts = column && byHealth(input.gvr, column, list.counts);
    const found = discovery.last(input.space);
    const singular =
      found?.state === "ready"
        ? found.value.find((resource) => sameGvr(resource.gvr, input.gvr))
            ?.singular
        : undefined;
    const rows =
      list.total === 1 && singular !== undefined
        ? singular
        : list.title.toLowerCase();
    return [
      { id: "rows", text: `${list.total.toLocaleString("en")} ${rows}` },
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
