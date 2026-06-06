import { useState } from "react";
import {
  ChevronRight,
  Circle,
  Plus,
  Search,
  Radio,
  RefreshCw,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";
import { useConnections } from "@/store/connections";
import { mockSubjects, type SubjectNode } from "@/lib/mock";

const viewTitles: Record<string, string> = {
  subjects: "Subjects",
  jetstream: "Streams & Consumers",
  kv: "KV Buckets",
  objectstore: "Object Stores",
  monitor: "Monitoring",
};

function ConnectionsSection() {
  const { contexts, status, error, activeContext, load, setActive } =
    useConnections();

  return (
    <>
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Connections
        </span>
        <div className="flex items-center gap-0.5">
          <button
            title="Reload nats contexts"
            onClick={() => load()}
            className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RefreshCw className="size-3.5" />
          </button>
          <button
            title="Add connection"
            className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="px-1.5">
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
          return (
            <button
              key={c.name}
              onClick={() => setActive(c.name)}
              title={`${c.url}${c.description ? ` — ${c.description}` : ""}`}
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left hover:bg-accent",
                active && "bg-accent",
              )}
            >
              <Circle className="size-2 shrink-0 fill-muted-foreground/40 text-muted-foreground/40" />
              <span className="flex-1 truncate text-xs font-medium">
                {c.name}
                {c.selected && (
                  <span className="ml-1 text-[10px] font-normal text-brand">
                    ★
                  </span>
                )}
              </span>
              <span className="truncate font-mono text-[10px] text-muted-foreground">
                {c.url.replace(/^\w+:\/\//, "")}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
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
        <SubjectRow key={n.token} node={n} depth={depth} />
      ))}
    </ul>
  );
}

function SubjectRow({ node, depth }: { node: SubjectNode; depth: number }) {
  const [open, setOpen] = useState(true);
  const hasChildren = !!node.children?.length;
  return (
    <li>
      <button
        onClick={() => hasChildren && setOpen((o) => !o)}
        className="group flex w-full items-center gap-1 rounded-sm py-1 pr-2 text-left hover:bg-accent"
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
        <span className="rounded bg-muted px-1 font-mono text-[10px] tabular-nums text-muted-foreground">
          {node.rate}/s
        </span>
      </button>
      {hasChildren && open && (
        <SubjectTree nodes={node.children!} depth={depth + 1} />
      )}
    </li>
  );
}

export function Sidebar() {
  const activeView = useUi((s) => s.activeView);
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
      <ConnectionsSection />

      <div className="my-1.5 border-t border-sidebar-border" />

      <div className="px-3 pb-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {viewTitles[activeView]}
        </span>
      </div>
      <div className="px-2 pb-1.5">
        <div className="flex items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1">
          <Search className="size-3.5 text-muted-foreground" />
          <input
            placeholder="Filter…"
            className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {activeView === "subjects" ? (
          <SubjectTree nodes={mockSubjects} />
        ) : (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            {viewTitles[activeView]} — coming soon.
          </p>
        )}
      </div>
    </aside>
  );
}
