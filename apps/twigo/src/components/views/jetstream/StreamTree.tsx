import {
  ChevronRight,
  Layers,
  ArrowDownToLine,
  Radio,
  Loader2,
  Pause,
} from "lucide-react";
import { useMemo } from "react";
import { cn } from "@twigo/ui";
import { fmtBytes, fmtCount } from "@twigo/utils";
import { useJetStream } from "@/store/jetstream";
import { openStreamDetail, openConsumerDetail } from "@/lib/editor";
import { VirtualTree } from "@/components/views/VirtualTree";
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

  const activate = (row: Row) => {
    if (row.kind === "stream") openStreamDetail(connId, row.stream.name);
    else openConsumerDetail(connId, row.stream, row.consumer.name);
  };
  // null = not expandable (consumers are leaves).
  const rowExpanded = (row: Row): boolean | null =>
    row.kind === "stream" ? !!expanded[row.stream.name] : null;
  const toggleRow = (row: Row) => {
    if (row.kind === "stream") void toggleStream(connId, row.stream.name);
  };

  return (
    <VirtualTree
      rows={rows}
      rowKey={(row) =>
        row.kind === "stream"
          ? `s:${row.stream.name}`
          : `c:${row.stream}:${row.consumer.name}`
      }
      nav={{
        onActivate: activate,
        expanded: rowExpanded,
        onExpand: toggleRow,
        onCollapse: toggleRow,
      }}
      renderRow={(row, selected) =>
        row.kind === "stream" ? (
          <StreamRow
            stream={row.stream}
            selected={selected}
            expanded={!!expanded[row.stream.name]}
            loading={!!loading[row.stream.name]}
            onToggle={() => void toggleStream(connId, row.stream.name)}
          />
        ) : (
          <ConsumerRow consumer={row.consumer} selected={selected} />
        )
      }
    />
  );
}

function StreamRow({
  stream,
  selected,
  expanded,
  loading,
  onToggle,
}: {
  stream: StreamSummary;
  selected: boolean;
  expanded: boolean;
  loading: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={cn(
        "group relative mx-1.5 flex h-full cursor-pointer items-center gap-1 rounded-md pl-2 pr-2 text-xs",
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
    </div>
  );
}

function ConsumerRow({
  consumer,
  selected,
}: {
  consumer: ConsumerSummary;
  selected: boolean;
}) {
  const Icon = consumer.kind === "push" ? Radio : ArrowDownToLine;
  return (
    <div
      className={cn(
        "group relative mx-1.5 flex h-full cursor-pointer items-center gap-1.5 rounded-md pl-8 pr-2 text-xs",
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
    </div>
  );
}
