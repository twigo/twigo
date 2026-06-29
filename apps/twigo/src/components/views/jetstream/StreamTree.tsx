import { useEffect, useMemo, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronRight,
  Layers,
  ArrowDownToLine,
  Radio,
  Loader2,
  Pause,
} from "lucide-react";
import { cn } from "@twigo/ui";
import { fmtBytes, fmtCount } from "@twigo/utils";
import { useJetStream } from "@/store/jetstream";
import { openStreamDetail, openConsumerDetail } from "@/lib/editor";
import type { StreamSummary, ConsumerSummary } from "@/lib/api";

const ROW_H = 26;

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

  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_H,
    overscan: 12,
  });
  // Keep the keyboard-selected row in view (rows unmount when scrolled off).
  useEffect(() => {
    if (sel >= 0) virtualizer.scrollToIndex(sel);
  }, [sel, virtualizer]);

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
    <div ref={setScrollEl} className="min-h-0 flex-1 overflow-y-auto">
      <ul
        role="tree"
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="relative w-full py-0.5 outline-none"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((v) => {
          const row = rows[v.index];
          if (!row) return null;
          const i = v.index;
          const style: React.CSSProperties = {
            height: v.size,
            transform: `translateY(${v.start.toString()}px)`,
          };
          return row.kind === "stream" ? (
            <StreamRow
              key={v.key}
              stream={row.stream}
              selected={i === sel}
              expanded={!!expanded[row.stream.name]}
              loading={!!loading[row.stream.name]}
              style={style}
              onSelect={() => setSelected(i)}
              onToggle={() => void toggleStream(connId, row.stream.name)}
              onOpen={() => open(row)}
            />
          ) : (
            <ConsumerRow
              key={v.key}
              consumer={row.consumer}
              selected={i === sel}
              style={style}
              onSelect={() => setSelected(i)}
              onOpen={() => open(row)}
            />
          );
        })}
      </ul>
    </div>
  );
}

function StreamRow({
  stream,
  selected,
  expanded,
  loading,
  style,
  onSelect,
  onToggle,
  onOpen,
}: {
  stream: StreamSummary;
  selected: boolean;
  expanded: boolean;
  loading: boolean;
  style: React.CSSProperties;
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
      className="absolute left-0 top-0 w-full"
      style={style}
    >
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
    </li>
  );
}

function ConsumerRow({
  consumer,
  selected,
  style,
  onSelect,
  onOpen,
}: {
  consumer: ConsumerSummary;
  selected: boolean;
  style: React.CSSProperties;
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
      className="absolute left-0 top-0 w-full"
      style={style}
    >
      <div
        className={cn(
          "group relative mx-1.5 flex h-full cursor-pointer items-center gap-1.5 rounded-md pl-8 pr-2 text-xs",
          selected ? "bg-selected" : "hover:bg-row-hover",
        )}
      >
        <Icon className="size-3 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono">
          {consumer.name}
        </span>
        {consumer.paused && <Pause className="size-3 shrink-0 text-warn" />}
        <span
          className={cn(
            "shrink-0 font-mono text-[10px] tabular-nums",
            consumer.numPending > 0 ? "text-warn" : "text-muted-foreground",
          )}
        >
          {consumer.kind} · {consumer.ackPolicy} ·{" "}
          {fmtCount(consumer.numPending)}
        </span>
      </div>
    </li>
  );
}
