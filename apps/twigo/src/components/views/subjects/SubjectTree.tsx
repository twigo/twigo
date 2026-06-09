import { useState } from "react";
import { ChevronRight, Radio, Send } from "lucide-react";
import {
  cn,
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@twigo/ui";
import { type SubjectNode } from "@twigo/utils";
import { useStream } from "@/store/stream";
import { openPublish } from "@/lib/editor";

function formatRate(rate: number): string {
  if (rate >= 10) return Math.round(rate).toString();
  if (rate > 0) return rate.toFixed(1);
  return "0";
}

export function SubjectTree({
  nodes,
  connId,
  depth = 0,
  onSelect,
}: {
  nodes: SubjectNode[];
  connId: string;
  depth?: number;
  onSelect: (subject: string) => void;
}) {
  return (
    <ul className="space-y-0.5">
      {nodes.map((n) => (
        <SubjectRow
          key={n.path}
          node={n}
          connId={connId}
          depth={depth}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

function SubjectRow({
  node,
  connId,
  depth,
  onSelect,
}: {
  node: SubjectNode;
  connId: string;
  depth: number;
  onSelect: (subject: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;
  const subject = hasChildren ? `${node.path}.>` : node.path;
  const isActive = useStream((s) =>
    Object.values(s.sessions).some(
      (x) => x.connId === connId && x.subject === subject,
    ),
  );

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              "group relative flex items-center rounded-sm",
              isActive ? "bg-accent" : "hover:bg-accent/50",
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
                onClick={() => setOpen((o) => !o)}
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
              title={`Stream ${subject} · ${node.count} msgs`}
              className="flex min-w-0 flex-1 items-center gap-1 py-1 pr-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex-1 truncate font-mono text-xs">
                {node.token}
              </span>
              <span
                className={cn(
                  "rounded bg-muted px-1 font-mono text-[11px] tabular-nums",
                  node.rate > 0 ? "text-foreground" : "text-muted-foreground",
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
        </ContextMenuContent>
      </ContextMenu>
      {open && hasChildren && (
        <SubjectTree
          nodes={node.children}
          connId={connId}
          depth={depth + 1}
          onSelect={onSelect}
        />
      )}
    </li>
  );
}
