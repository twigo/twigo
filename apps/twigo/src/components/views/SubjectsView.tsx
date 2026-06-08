import { useMemo, useState } from "react";
import { ChevronRight, Radio, Play, Square } from "lucide-react";
import { Button, cn } from "@twigo/ui";
import { useConnections } from "@/store/connections";
import { useSubjects } from "@/store/subjects";
import { useStream } from "@/store/stream";
import { buildSubjectTree, type SubjectNode } from "@twigo/utils";
import { openStream } from "@/lib/editor";

function formatRate(rate: number): string {
  if (rate >= 10) return Math.round(rate).toString();
  if (rate > 0) return rate.toFixed(1);
  return "0";
}

function SubjectTree({
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

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}

export function SubjectsView({ filter }: { filter: string }) {
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
        <SubjectTree
          nodes={tree}
          connId={activeContext}
          onSelect={(subject) => {
            void openStream(activeContext, subject);
          }}
        />
      )}
      {data?.truncated && (
        <p className="px-2 py-2 text-[11px] text-warn">
          Showing the first 5000 subjects.
        </p>
      )}
    </div>
  );
}
