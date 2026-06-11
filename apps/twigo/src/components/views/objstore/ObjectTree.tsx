import { useMemo, useState } from "react";
import { ChevronRight, Box, File, Loader2, Trash2 } from "lucide-react";
import { cn } from "@twigo/ui";
import { fmtBytes, fmtCount } from "@twigo/utils";
import { useObjStore } from "@/store/objstore";
import { openObjectEntry } from "@/lib/editor";
import type { ObjBucketSummary, ObjSummary } from "@/lib/api";

type Row =
  | { kind: "bucket"; bucket: ObjBucketSummary }
  | { kind: "object"; bucket: string; object: ObjSummary };

export function ObjectTree({
  connId,
  buckets,
}: {
  connId: string;
  buckets: ObjBucketSummary[];
}) {
  const expanded = useObjStore((s) => s.byConn[connId]?.expanded ?? {});
  const objectsByBucket = useObjStore((s) => s.byConn[connId]?.objects ?? {});
  const loading = useObjStore((s) => s.byConn[connId]?.objectsLoading ?? {});
  const toggleBucket = useObjStore((s) => s.toggleBucket);

  const [selected, setSelected] = useState(0);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const bucket of buckets) {
      out.push({ kind: "bucket", bucket });
      if (expanded[bucket.bucket]) {
        for (const object of objectsByBucket[bucket.bucket] ?? []) {
          out.push({ kind: "object", bucket: bucket.bucket, object });
        }
      }
    }
    return out;
  }, [buckets, expanded, objectsByBucket]);

  const sel = Math.min(selected, rows.length - 1);

  const open = (row: Row) => {
    if (row.kind === "bucket") void toggleBucket(connId, row.bucket.bucket);
    else openObjectEntry(connId, row.bucket, row.object.name);
  };

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
    } else if (e.key === "ArrowRight" && row?.kind === "bucket") {
      if (!expanded[row.bucket.bucket]) {
        e.preventDefault();
        void toggleBucket(connId, row.bucket.bucket);
      }
    } else if (e.key === "ArrowLeft" && row?.kind === "bucket") {
      if (expanded[row.bucket.bucket]) {
        e.preventDefault();
        void toggleBucket(connId, row.bucket.bucket);
      }
    }
  };

  return (
    <ul
      role="tree"
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="min-h-0 flex-1 overflow-auto py-0.5 outline-none"
    >
      {rows.map((row, i) =>
        row.kind === "bucket" ? (
          <BucketRow
            key={`b:${row.bucket.bucket}`}
            bucket={row.bucket}
            selected={i === sel}
            expanded={!!expanded[row.bucket.bucket]}
            loading={!!loading[row.bucket.bucket]}
            onSelect={() => setSelected(i)}
            onToggle={() => void toggleBucket(connId, row.bucket.bucket)}
          />
        ) : (
          <ObjectRow
            key={`o:${row.bucket}:${row.object.name}`}
            object={row.object}
            selected={i === sel}
            onSelect={() => setSelected(i)}
            onOpen={() => openObjectEntry(connId, row.bucket, row.object.name)}
          />
        ),
      )}
    </ul>
  );
}

function BucketRow({
  bucket,
  selected,
  expanded,
  loading,
  onSelect,
  onToggle,
}: {
  bucket: ObjBucketSummary;
  selected: boolean;
  expanded: boolean;
  loading: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  return (
    <li
      role="treeitem"
      aria-selected={selected}
      aria-expanded={expanded}
      onClick={onSelect}
      onDoubleClick={onToggle}
      className={cn(
        "group relative flex cursor-pointer items-center gap-1 py-1 pl-2 pr-2 text-xs",
        selected ? "bg-accent" : "hover:bg-accent/50",
      )}
    >
      {selected && (
        <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-brand" />
      )}
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
      <Box className="size-3 shrink-0 text-brand" />
      <span className="min-w-0 flex-1 truncate font-mono">{bucket.bucket}</span>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
        {fmtBytes(bucket.bytes)} · {bucket.storage}
      </span>
    </li>
  );
}

function ObjectRow({
  object,
  selected,
  onSelect,
  onOpen,
}: {
  object: ObjSummary;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  return (
    <li
      role="treeitem"
      aria-selected={selected}
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={cn(
        "group relative flex cursor-pointer items-center gap-1.5 py-1 pl-8 pr-2 text-xs",
        selected ? "bg-accent" : "hover:bg-accent/50",
      )}
    >
      {selected && (
        <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-brand" />
      )}
      <File className="size-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-mono">{object.name}</span>
      {object.deleted && <Trash2 className="size-3 shrink-0 text-warn" />}
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
        {fmtBytes(object.size)} · {fmtCount(object.chunks)} chunks
      </span>
    </li>
  );
}
