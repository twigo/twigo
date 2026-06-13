import { useMemo, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, Radio, Send, Webhook } from "lucide-react";
import {
  cn,
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@twigo/ui";
import { type SubjectNode } from "@twigo/utils";
import { useStream } from "@/store/stream";
import { useFlash } from "@/hooks/useFlash";
import { openPublish, openResponder } from "@/lib/editor";

const ROW_H = 26;

interface Row {
  node: SubjectNode;
  depth: number;
}

function formatRate(rate: number): string {
  if (rate >= 10) return Math.round(rate).toString();
  if (rate > 0) return rate.toFixed(1);
  return "0";
}

function flatten(nodes: SubjectNode[], collapsed: Set<string>): Row[] {
  const out: Row[] = [];
  const walk = (ns: SubjectNode[], depth: number) => {
    for (const node of ns) {
      out.push({ node, depth });
      if (node.children.length && !collapsed.has(node.path)) {
        walk(node.children, depth + 1);
      }
    }
  };
  walk(nodes, 0);
  return out;
}

export function SubjectTree({
  nodes,
  connId,
  onSelect,
}: {
  nodes: SubjectNode[];
  connId: string;
  onSelect: (subject: string) => void;
}) {
  // Collapse state lives here, not in rows: virtualized rows unmount offscreen.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  const rows = useMemo(() => flatten(nodes, collapsed), [nodes, collapsed]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_H,
    overscan: 12,
    getItemKey: (i) => rows[i]?.node.path ?? i,
  });

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div ref={setScrollEl} className="min-h-0 flex-1 overflow-y-auto">
      <ul
        role="tree"
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((v) => {
          const row = rows[v.index];
          if (!row) return null;
          return (
            <SubjectRow
              key={v.key}
              node={row.node}
              depth={row.depth}
              connId={connId}
              open={!collapsed.has(row.node.path)}
              onToggle={() => toggle(row.node.path)}
              onSelect={onSelect}
              style={{
                height: v.size,
                transform: `translateY(${v.start.toString()}px)`,
              }}
            />
          );
        })}
      </ul>
    </div>
  );
}

function SubjectRow({
  node,
  depth,
  connId,
  open,
  onToggle,
  onSelect,
  style,
}: {
  node: SubjectNode;
  depth: number;
  connId: string;
  open: boolean;
  onToggle: () => void;
  onSelect: (subject: string) => void;
  style: React.CSSProperties;
}) {
  const hasChildren = node.children.length > 0;
  const subject = hasChildren ? `${node.path}.>` : node.path;
  const isActive = useStream((s) =>
    Object.values(s.sessions).some(
      (x) => x.connId === connId && x.subject === subject,
    ),
  );
  const flash = useFlash(node.rate);

  return (
    <li
      role="treeitem"
      aria-selected={isActive}
      aria-expanded={hasChildren ? open : undefined}
      className="absolute left-0 top-0 w-full pb-0.5"
      style={style}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              "group relative flex h-full items-center rounded-sm",
              isActive ? "bg-selected" : "hover:bg-row-hover",
            )}
            style={{ paddingLeft: depth * 12 }}
          >
            {isActive && (
              <span className="absolute inset-y-0.5 left-0 w-0.5 rounded-full bg-brand" />
            )}
            {hasChildren ? (
              <button
                type="button"
                aria-label={open ? "Collapse" : "Expand"}
                aria-expanded={open}
                onClick={onToggle}
                className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronRight
                  className={cn(
                    "size-3.5 transition-transform",
                    open && "rotate-90",
                  )}
                />
              </button>
            ) : (
              <span className="flex size-5 shrink-0 items-center justify-center">
                <Radio className="size-3.5 text-muted-foreground/60" />
              </span>
            )}
            <button
              type="button"
              onClick={() => onSelect(subject)}
              title={`Stream ${subject} · ${node.count.toString()} msgs`}
              className="flex min-w-0 flex-1 items-center gap-1 py-1 pr-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex-1 truncate font-mono text-xs">
                {node.token}
              </span>
              <span
                className={cn(
                  "rounded px-1 font-mono text-[11px] tabular-nums transition-colors duration-500",
                  node.rate > 0 ? "text-foreground" : "text-muted-foreground",
                  flash ? "bg-brand/15" : "bg-muted",
                )}
              >
                {formatRate(node.rate)}/s
              </span>
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => onSelect(subject)}>
            <Radio />
            Stream
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => {
              openPublish(connId, subject);
            }}
          >
            <Send />
            Publish to subject
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => {
              openResponder(connId, subject);
            }}
          >
            <Webhook />
            Mock this subject…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}
