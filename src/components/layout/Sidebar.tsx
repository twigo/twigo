import { useMemo, useState } from "react";
import {
  ChevronRight,
  Circle,
  Plus,
  Search,
  Radio,
  RefreshCw,
  Loader2,
  Unplug,
  Play,
  Square,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useUi } from "@/store/ui";
import { useConnections } from "@/store/connections";
import { useSubjects } from "@/store/subjects";
import { buildSubjectTree, type SubjectNode } from "@/lib/subject-tree";

const viewTitles: Record<string, string> = {
  subjects: "Subjects",
  jetstream: "Streams & Consumers",
  kv: "KV Buckets",
  objectstore: "Object Stores",
  monitor: "Monitoring",
};

function ConnectionsSection() {
  const {
    contexts,
    status,
    error,
    activeContext,
    connected,
    connecting,
    connError,
    load,
    setActive,
    connect,
    disconnect,
  } = useConnections();

  return (
    <>
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Connections
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Reload nats contexts"
            title="Reload nats contexts"
            onClick={() => void load()}
            className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RefreshCw className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Add connection"
            title="Add connection"
            className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="space-y-0.5 px-1.5">
        {status === "loading" && (
          <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Loading contexts…
          </div>
        )}

        {status === "error" && (
          <p className="px-2 py-1.5 text-xs text-error">{error}</p>
        )}

        {status === "ready" && contexts.length === 0 && (
          <p className="px-2 py-2 text-xs leading-relaxed text-muted-foreground">
            No nats contexts found in{" "}
            <span className="font-mono">~/.config/nats/context</span>.
          </p>
        )}

        {contexts.map((c) => {
          const active = activeContext === c.name;
          const isConnected = !!connected[c.name];
          const isConnecting = !!connecting[c.name];
          const err = connError[c.name];
          return (
            <div
              key={c.name}
              className={cn(
                "group relative flex h-7 w-full items-center rounded-md transition-colors hover:bg-accent",
                active && "bg-accent",
              )}
            >
              {active && (
                <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-brand" />
              )}
              <button
                type="button"
                onClick={() => {
                  if (isConnected) {
                    setActive(c.name);
                  } else {
                    void connect(c.name);
                  }
                }}
                aria-current={active ? "true" : undefined}
                title={
                  err ?? `${c.url}${c.description ? ` — ${c.description}` : ""}`
                }
                className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {isConnecting ? (
                  <Loader2 className="size-2.5 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <Circle
                    className={cn(
                      "size-2 shrink-0",
                      isConnected
                        ? "fill-ok text-ok"
                        : err
                          ? "fill-error text-error"
                          : "fill-muted-foreground/40 text-muted-foreground/40",
                    )}
                  />
                )}
                <span className="flex-1 truncate text-xs font-medium">
                  {c.name}
                  {c.selected && (
                    <span className="ml-1 text-[11px] font-normal text-brand">
                      ★
                    </span>
                  )}
                </span>
                {!isConnected && (
                  <span className="truncate font-mono text-[11px] text-muted-foreground">
                    {c.url.replace(/^\w+:\/\//, "")}
                  </span>
                )}
              </button>
              {isConnected && (
                <button
                  type="button"
                  aria-label={`Disconnect ${c.name}`}
                  title="Disconnect"
                  onClick={() => void disconnect(c.name)}
                  className="mr-1 flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-error focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
                >
                  <Unplug className="size-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function formatRate(rate: number): string {
  if (rate >= 10) return Math.round(rate).toString();
  if (rate > 0) return rate.toFixed(1);
  return "0";
}

function SubjectTree({
  nodes,
  depth = 0,
}: {
  nodes: SubjectNode[];
  depth?: number;
}) {
  return (
    <ul>
      {nodes.map((n) => (
        <SubjectRow key={n.path} node={n} depth={depth} />
      ))}
    </ul>
  );
}

function SubjectRow({ node, depth }: { node: SubjectNode; depth: number }) {
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;
  return (
    <li>
      <button
        type="button"
        onClick={() => hasChildren && setOpen((o) => !o)}
        aria-expanded={hasChildren ? open : undefined}
        title={`${node.path} · ${node.count} msgs`}
        className="group flex w-full items-center gap-1 rounded-sm py-1 pr-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ paddingLeft: depth * 12 + 6 }}
      >
        {hasChildren ? (
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        ) : (
          <Radio className="size-3.5 shrink-0 text-muted-foreground/60" />
        )}
        <span className="flex-1 truncate font-mono text-xs">{node.token}</span>
        <span
          className={cn(
            "rounded bg-muted px-1 font-mono text-[11px] tabular-nums",
            node.rate > 0 ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {formatRate(node.rate)}/s
        </span>
      </button>
      {open && hasChildren && (
        <SubjectTree nodes={node.children} depth={depth + 1} />
      )}
    </li>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}

function SubjectExplorer({ filter }: { filter: string }) {
  const { activeContext, connected } = useConnections();
  const isConnected = !!(activeContext && connected[activeContext]);
  const data = useSubjects((s) =>
    activeContext ? s.byConn[activeContext] : undefined,
  );
  const watchingPattern = useSubjects((s) =>
    activeContext ? s.watching[activeContext] : undefined,
  );
  const startWatch = useSubjects((s) => s.startWatch);
  const stopWatch = useSubjects((s) => s.stopWatch);
  const [pattern, setPattern] = useState(">");

  const tree = useMemo(() => {
    const stats = data?.stats ?? [];
    const f = filter.trim().toLowerCase();
    const filtered = f
      ? stats.filter((s) => s.subject.toLowerCase().includes(f))
      : stats;
    return buildSubjectTree(filtered);
  }, [data?.stats, filter]);

  if (!isConnected || !activeContext) {
    return <Hint>Connect to a server to explore subjects.</Hint>;
  }

  if (!watchingPattern) {
    return (
      <div className="space-y-2 px-2 py-2">
        <Hint>
          Core NATS has no subject registry. Subscribe to a pattern to discover
          subjects from live traffic — this receives matching messages while
          running.
        </Hint>
        <div className="flex items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1">
          <span className="font-mono text-[11px] text-muted-foreground">
            pattern
          </span>
          <input
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            aria-label="Subject pattern to watch"
            spellCheck={false}
            className="w-full bg-transparent font-mono text-xs outline-none"
          />
        </div>
        <Button
          variant="brand"
          size="sm"
          className="w-full"
          onClick={() => void startWatch(activeContext, pattern)}
        >
          <Play />
          Start listening
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-2 pb-1.5">
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-ok" />
          <span className="truncate font-mono">{watchingPattern}</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void stopWatch(activeContext)}
        >
          <Square />
          Stop
        </Button>
      </div>
      {tree.length === 0 ? (
        <Hint>
          {filter ? "No matching subjects." : "No messages observed yet."}
        </Hint>
      ) : (
        <SubjectTree nodes={tree} />
      )}
      {data?.truncated && (
        <p className="px-2 py-2 text-[11px] text-warn">
          Showing the first 5000 subjects.
        </p>
      )}
    </div>
  );
}

export function Sidebar() {
  const activeView = useUi((s) => s.activeView);
  const [filter, setFilter] = useState("");
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
      <ConnectionsSection />

      <div className="my-1.5 border-t border-sidebar-border" />

      <div className="px-3 pb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {viewTitles[activeView]}
        </span>
      </div>
      <div className="px-2 pb-1.5">
        <div className="flex items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1">
          <Search className="size-3.5 text-muted-foreground" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label={`Filter ${viewTitles[activeView] ?? ""}`}
            placeholder="Filter…"
            className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {activeView === "subjects" ? (
          <SubjectExplorer filter={filter} />
        ) : (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            {viewTitles[activeView]} — coming soon.
          </p>
        )}
      </div>
    </aside>
  );
}
