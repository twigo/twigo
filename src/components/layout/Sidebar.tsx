import { useState } from "react";
import {
  ChevronRight,
  Circle,
  Plus,
  Search,
  Radio,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";
import {
  mockConnections,
  mockSubjects,
  type SubjectNode,
} from "@/lib/mock";

const viewTitles: Record<string, string> = {
  subjects: "Subjects",
  jetstream: "Streams & Consumers",
  kv: "KV Buckets",
  objectstore: "Object Stores",
  monitor: "Monitoring",
};

function SubjectTree({ nodes, depth = 0 }: { nodes: SubjectNode[]; depth?: number }) {
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
      {/* Connections */}
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Connections
        </span>
        <button
          title="Add connection"
          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      <div className="px-1.5">
        {mockConnections.map((c) => (
          <button
            key={c.id}
            className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left hover:bg-accent"
          >
            <Circle
              className={cn(
                "size-2 shrink-0",
                c.status === "connected"
                  ? "fill-ok text-ok"
                  : "fill-muted-foreground/40 text-muted-foreground/40",
              )}
            />
            <span className="flex-1 truncate text-xs font-medium">{c.name}</span>
            <span className="truncate font-mono text-[10px] text-muted-foreground">
              {c.url.replace(/^\w+:\/\//, "")}
            </span>
          </button>
        ))}
      </div>

      <div className="my-1.5 border-t border-sidebar-border" />

      {/* Active view header + search */}
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

      {/* Tree */}
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
