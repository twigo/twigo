import type { ReactNode } from "react";
import { CircleX, Clock } from "lucide-react";
import type { Gvr, Resource } from "@twigo/protocol";
import {
  Button,
  Count,
  KeyHints,
  StatTile,
  type KeyHint,
  type StatSegment,
} from "@twigo/ui";
import { SpaceTile, useChanges, useWorkbench } from "@twigo/workbench";
import { byHealth, statusColumn, type Health } from "../columns";
import { useClusterVersion, useResources, type Loaded } from "../discovery";
import { PODS } from "../kinds";
import type { ListServices } from "../services";
import { recentRow } from "../quickaccess";
import { listUri } from "../uri";
import { exactly, podStatusWords, unit, type Attention } from "./attention";
import { useTally, type Tally } from "./useTally";

const NODES: Gvr = { group: "", version: "v1", resource: "nodes" };
const DEPLOYMENTS: Gvr = {
  group: "apps",
  version: "v1",
  resource: "deployments",
};
const EVENTS: Gvr = { group: "", version: "v1", resource: "events" };
/** An event's Type when something went wrong, `corev1.EventTypeWarning`. */
const WARNING = "Warning";

/**
 * A space's home, in its editor area while no editor is open: the
 * cluster's counts, each opening its list filtered, what needs attention,
 * and the keys that open things. Rust counts every list; none sends rows.
 */
export function Home({
  space: id,
  services,
}: {
  space: string;
  services: ListServices;
}) {
  const { spaces, editors } = useWorkbench();
  useChanges(spaces.changes);
  const space = spaces.list.find((candidate) => candidate.id === id);
  const resources = useResources(services.discovery, id);
  const scope = spaces.state(id).namespaces;
  const nodes = useTally(id, resources, NODES, statusColumn(NODES), scope);
  const pods = useTally(id, resources, PODS, statusColumn(PODS), scope);
  const deployments = useTally(
    id,
    resources,
    DEPLOYMENTS,
    statusColumn(DEPLOYMENTS),
    scope,
  );
  const events = useTally(id, resources, EVENTS, "Type", scope);
  const [only, ...more] = space?.contexts ?? [];
  const version = useClusterVersion(
    services.discovery,
    more.length === 0 ? only : undefined,
  );
  if (!space) return null;

  const open = (
    tally: Tally,
    filter: { health?: Health; text?: string } = {},
  ) => {
    if (tally.state !== "counted") return undefined;
    const { gvr } = tally.resource;
    return () => {
      editors.open(listUri({ space: id, gvr, ...filter }));
    };
  };
  const notReady = healthOf(nodes)?.error.count ?? 0;
  const podHealth = healthOf(pods);
  const failing = podHealth?.error.count ?? 0;
  const pending = podHealth?.warn.count ?? 0;
  const short = healthOf(deployments)?.warn.count ?? 0;
  const warnings =
    events.state === "counted"
      ? (events.counts.find((value) => value.value === WARNING)?.count ?? 0)
      : 0;

  const attention: (Attention & { show: () => void })[] = [
    ...(pods.state === "counted" && podHealth
      ? (["error", "warn"] as const)
          .flatMap((tone) =>
            podHealth[tone].values.map(({ value, count }) => ({
              id: `pods/${value}`,
              tone,
              title: value,
              count,
              unit: unit(count, "pod", "pods"),
              words: podStatusWords(value),
              show: () => {
                editors.open(
                  listUri({
                    space: id,
                    gvr: pods.resource.gvr,
                    text: exactly(value),
                  }),
                );
              },
            })),
          )
          .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
      : []),
    ...(nodes.state === "counted" && notReady > 0
      ? [
          {
            id: "nodes",
            tone: "error" as const,
            title: "Not ready",
            count: notReady,
            unit: unit(notReady, "node", "nodes"),
            words:
              "Their kubelet reports them not ready, or stopped reporting.",
            show: () => {
              editors.open(
                listUri({
                  space: id,
                  gvr: nodes.resource.gvr,
                  health: "error",
                }),
              );
            },
          },
        ]
      : []),
    ...(deployments.state === "counted" && short > 0
      ? [
          {
            id: "deployments",
            tone: "warn" as const,
            title: "Short of ready",
            count: short,
            unit: unit(short, "deployment", "deployments"),
            words: "Fewer of their pods are ready than they ask for.",
            show: () => {
              editors.open(
                listUri({
                  space: id,
                  gvr: deployments.resource.gvr,
                  health: "warn",
                }),
              );
            },
          },
        ]
      : []),
  ];
  const settled = [nodes, pods, deployments].every(
    (tally) => tally.state === "counted",
  );

  return (
    <div className="@container h-full overflow-auto bg-editor">
      <div className="grid max-w-[1000px] gap-[18px] px-7 py-[22px]">
        <header className="grid gap-1">
          <div className="flex items-center gap-2">
            <SpaceTile space={space} className="size-7" />
            <h1 className="truncate text-lg font-semibold">{space.name}</h1>
          </div>
          <p className="text-xs text-muted-foreground">
            {[
              version && `Kubernetes ${version}`,
              nodes.state === "counted" &&
                `${nodes.total.toLocaleString("en")} ${unit(nodes.total, "node", "nodes")}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </header>
        <section
          aria-label="Counts"
          className="grid grid-cols-2 gap-2.5 @3xl:grid-cols-4"
        >
          <Tile
            label="Nodes"
            tally={nodes}
            onOpen={open(nodes, notReady > 0 ? { health: "error" } : {})}
          >
            {notReady > 0 ? (
              <>
                <Count value={notReady} tone="error" /> not ready
              </>
            ) : (
              <span className="text-muted-foreground">All ready</span>
            )}
          </Tile>
          <Tile
            label="Pods"
            tally={pods}
            segments={[
              { tone: "error", value: failing },
              { tone: "warn", value: pending },
            ]}
            onOpen={open(
              pods,
              failing > 0
                ? { health: "error" }
                : pending > 0
                  ? { health: "warn" }
                  : {},
            )}
          >
            {failing + pending > 0 ? (
              <>
                <Count value={failing} tone={failing > 0 ? "error" : "quiet"} />{" "}
                failing <span className="text-muted-foreground">·</span>{" "}
                <Count value={pending} tone={pending > 0 ? "warn" : "quiet"} />{" "}
                pending
              </>
            ) : (
              <span className="text-muted-foreground">
                None failing or pending
              </span>
            )}
          </Tile>
          <Tile
            label="Deployments"
            tally={deployments}
            onOpen={open(deployments, short > 0 ? { health: "warn" } : {})}
          >
            {short > 0 ? (
              <>
                <Count value={short} tone="warn" /> short of ready
              </>
            ) : (
              <span className="text-muted-foreground">All ready</span>
            )}
          </Tile>
          <Tile
            label="Warning events"
            tally={events}
            value={warnings}
            onOpen={open(
              events,
              warnings > 0 ? { text: exactly(WARNING) } : {},
            )}
          >
            {events.state === "counted" && (
              <span className="text-muted-foreground">
                of <Count value={events.total} />{" "}
                {unit(events.total, "event", "events")}
              </span>
            )}
          </Tile>
        </section>
        <div className="grid items-start gap-6 @3xl:grid-cols-[1.6fr_1fr]">
          <section aria-label="Needs attention" className="grid gap-2">
            <h2 className="text-[11px] font-semibold text-muted-foreground">
              Needs attention
            </h2>
            {attention.length > 0 ? (
              <ul className="grid">
                {attention.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center gap-3 border-b border-border-subtle py-[9px]"
                  >
                    {item.tone === "error" ? (
                      <CircleX
                        aria-hidden
                        className="size-4 shrink-0 text-error"
                      />
                    ) : (
                      <Clock
                        aria-hidden
                        className="size-4 shrink-0 text-warn-foreground"
                      />
                    )}
                    <div className="grid min-w-0 flex-1 gap-0.5">
                      <span className="truncate">
                        <span
                          className={
                            item.tone === "error"
                              ? "font-semibold text-error"
                              : "font-semibold text-warn-foreground"
                          }
                        >
                          {item.title}
                        </span>{" "}
                        <span className="text-muted-foreground">
                          · <Count value={item.count} /> {item.unit}
                        </span>
                      </span>
                      {item.words && (
                        <span className="truncate text-xs text-muted-foreground">
                          {item.words}
                        </span>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Show ${item.title}`}
                      onClick={item.show}
                    >
                      Show
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              settled && (
                <p className="text-xs text-muted-foreground">
                  Nothing needs attention.
                </p>
              )
            )}
          </section>
          <aside className="grid gap-2">
            <Recent space={id} resources={resources} />
            <h2 className="text-[11px] font-semibold text-muted-foreground">
              Keys
            </h2>
            <Keys />
          </aside>
        </div>
      </div>
    </div>
  );
}

/** A list's rows by health, when its kind has a health column. */
function healthOf(tally: Tally) {
  if (tally.state !== "counted") return undefined;
  const { gvr } = tally.resource;
  const column = statusColumn(gvr);
  return column === undefined ? undefined : byHealth(gvr, column, tally.counts);
}

/** A count as a tile: loading, missing with why, or counted. */
function Tile({
  label,
  tally,
  value,
  segments,
  onOpen,
  children,
}: {
  label: string;
  tally: Tally;
  /** What the tile counts, when not the list's rows. */
  value?: number;
  segments?: readonly StatSegment[];
  onOpen: (() => void) | undefined;
  children: ReactNode;
}) {
  if (tally.state === "missing")
    return (
      <StatTile label={label} value={undefined}>
        <span className="text-muted-foreground">{tally.why}</span>
      </StatTile>
    );
  return (
    <StatTile
      label={label}
      value={tally.state === "counted" ? (value ?? tally.total) : undefined}
      loading={tally.state === "loading"}
      {...(segments && { segments })}
      {...(onOpen && { onOpen })}
    >
      {tally.state === "counted" && tally.total > 0 && children}
    </StatTile>
  );
}

/** The editors the space opened last, newest first, each opening again. */
function Recent({
  space,
  resources,
}: {
  space: string;
  resources: Loaded<readonly Resource[]>;
}) {
  const { recent, editors } = useWorkbench();
  useChanges(recent.changes);
  const entries = recent.list(space).slice(0, 5);
  if (entries.length === 0) return null;
  const known = resources.state === "ready" ? resources.value : [];
  return (
    <section aria-label="Recent" className="mb-2.5 grid gap-2">
      <h2 className="text-[11px] font-semibold text-muted-foreground">
        Recent
      </h2>
      <ul className="grid">
        {entries.map((entry) => {
          const row = recentRow(entry, known);
          const Icon = row.icon;
          const detail = [row.kind, row.description]
            .filter(Boolean)
            .join(" · ");
          return (
            <li key={entry.uri}>
              <button
                type="button"
                onClick={() => {
                  editors.open(entry.uri);
                }}
                className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md text-left outline-none hover:bg-row-hover focus-visible:shadow-[var(--focus-ring)]"
              >
                {Icon && (
                  <Icon
                    aria-hidden
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                )}
                <span className="truncate">{row.label}</span>
                {detail && (
                  <span className="truncate text-xs text-muted-foreground">
                    {detail}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The keys that open things, from the keybinding registry. */
function Keys() {
  const { keybindings } = useWorkbench();
  useChanges(keybindings.changes);
  const keys = (command: string) => {
    const binding = keybindings.primary(command);
    return binding && keybindings.label(binding.presses);
  };
  const quickOpen = keys("workbench.action.quickOpen");
  const commands = keys("workbench.action.showCommands");
  const hints: KeyHint[] = [
    ...(quickOpen
      ? [{ id: "quickOpen", keys: quickOpen, label: "Go to resource" }]
      : []),
    ...(commands
      ? [{ id: "commands", keys: commands, label: "Commands" }]
      : []),
    ...(quickOpen
      ? [
          {
            id: "lists",
            keys: `${quickOpen} :`,
            label: (
              <>
                Open a list, k9s style:{" "}
                <span className="font-mono">:deploy payments</span>
              </>
            ),
          },
        ]
      : []),
  ];
  return <KeyHints hints={hints} />;
}
