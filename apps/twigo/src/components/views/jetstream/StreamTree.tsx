import { useMemo, useState } from "react";
import {
  ChevronRight,
  Layers,
  ArrowDownToLine,
  Radio,
  Loader2,
  Pause,
} from "lucide-react";
import { cn, ScrollArea } from "@twigo/ui";
import { fmtBytes, fmtCount } from "@twigo/utils";
import { useJetStream } from "@/store/jetstream";
import { openStreamDetail, openConsumerDetail } from "@/lib/editor";
import type { StreamSummary, ConsumerSummary } from "@/lib/api";

type Row =
  | { kind: "stream"; stream: StreamSummary }
  | { kind: "consumer"; stream: string; consumer: ConsumerSummary };

export function StreamTree({
  connId,
  streams,
}: {
  connId: string;
  streams: StreamSummary[];
}) {
  const expanded = useJetStream((s) => s.byConn[connId]?.expanded ?? {});
  const consumers = useJetStream((s) => s.byConn[connId]?.children ?? {});
  const loading = useJetStream((s) => s.byConn[connId]?.childrenLoading ?? {});
  const toggleStream = useJetStream((s) => s.toggle);

  const [selected, setSelected] = useState(0);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const stream of streams) {
      out.push({ kind: "stream", stream });
      if (expanded[stream.name]) {
        for (const consumer of consumers[stream.name] ?? []) {
          out.push({ kind: "consumer", stream: stream.name, consumer });
        }
      }
    }
    return out;
  }, [streams, expanded, consumers]);

  const sel = Math.min(selected, rows.length - 1);

  const open = (row: Row) => {
    if (row.kind === "stream") openStreamDetail(connId, row.stream.name);
    else openConsumerDetail(connId, row.stream, row.consumer.name);
  };

  // Keyboard-first: arrows move selection, Enter opens, Right/Left expand/
  // collapse a stream. Single-click only selects (no RPC), double-click opens.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const row = rows[sel];
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected(Math.min(sel + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected(Math.max(sel - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (row) open(row);
    } else if (e.key === "ArrowRight" && row?.kind === "stream") {
      if (!expanded[row.stream.name]) {
        e.preventDefault();
        void toggleStream(connId, row.stream.name);
      }
    } else if (e.key === "ArrowLeft" && row?.kind === "stream") {
      if (expanded[row.stream.name]) {
        e.preventDefault();
        void toggleStream(connId, row.stream.name);
      }
    }
  };

  return (
    <ScrollArea className="min-h-0 flex-1">
      <ul
        role="tree"
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="py-0.5 outline-none"
      >
        {rows.map((row, i) =>
          row.kind === "stream" ? (
            <StreamRow
              key={`s:${row.stream.name}`}
              stream={row.stream}
              selected={i === sel}
              expanded={!!expanded[row.stream.name]}
              loading={!!loading[row.stream.name]}
              onSelect={() => setSelected(i)}
              onToggle={() => void toggleStream(connId, row.stream.name)}
              onOpen={() => open(row)}
            />
          ) : (
            <ConsumerRow
              key={`c:${row.stream}:${row.consumer.name}`}
              consumer={row.consumer}
              selected={i === sel}
              onSelect={() => setSelected(i)}
              onOpen={() => open(row)}
            />
          ),
        )}
      </ul>
    </ScrollArea>
  );
}

function StreamRow({
  stream,
  selected,
  expanded,
  loading,
  onSelect,
  onToggle,
  onOpen,
}: {
  stream: StreamSummary;
  selected: boolean;
  expanded: boolean;
  loading: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onOpen: () => void;
}) {
  return (
    <li
      role="treeitem"
      aria-selected={selected}
      aria-expanded={expanded}
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={cn(
        "group relative mx-1.5 rounded-md flex cursor-pointer items-center gap-1 py-1 pl-2 pr-2 text-xs",
        selected ? "bg-selected" : "hover:bg-row-hover",
      )}
    >
      <button
        type="button"
        aria-label={expanded ? "Collapse" : "Expand"}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
      >
        {loading ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <ChevronRight
            className={cn(
              "size-3 transition-transform",
              expanded && "rotate-90",
            )}
          />
        )}
      </button>
      <Layers className="size-3 shrink-0 text-brand" />
      <span className="min-w-0 flex-1 truncate font-mono">{stream.name}</span>
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
        {fmtCount(stream.messages)} · {fmtBytes(stream.bytes)} ·{" "}
        {stream.storage} · {stream.consumerCount}
      </span>
    </li>
  );
}

function ConsumerRow({
  consumer,
  selected,
  onSelect,
  onOpen,
}: {
  consumer: ConsumerSummary;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const Icon = consumer.kind === "push" ? Radio : ArrowDownToLine;
  return (
    <li
      role="treeitem"
      aria-selected={selected}
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={cn(
        "group relative mx-1.5 rounded-md flex cursor-pointer items-center gap-1.5 py-1 pl-8 pr-2 text-xs",
        selected ? "bg-selected" : "hover:bg-row-hover",
      )}
    >
      <Icon className="size-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-mono">{consumer.name}</span>
      {consumer.paused && <Pause className="size-3 shrink-0 text-warn" />}
      <span
        className={cn(
          "shrink-0 font-mono text-[10px] tabular-nums",
          consumer.numPending > 0 ? "text-warn" : "text-muted-foreground",
        )}
      >
        {consumer.kind} · {consumer.ackPolicy} · {fmtCount(consumer.numPending)}
      </span>
    </li>
  );
}
