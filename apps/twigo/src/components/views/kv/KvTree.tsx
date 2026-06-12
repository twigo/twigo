import { useMemo, useState } from "react";
import {
  ChevronRight,
  Database,
  Folder,
  Key,
  Loader2,
  Trash2,
  Plus,
} from "lucide-react";
import { cn } from "@twigo/ui";
import {
  fmtBytes,
  fmtCount,
  encodeText,
  buildSubjectTree,
  type SubjectNode,
} from "@twigo/utils";
import { kvCreate, kvDeleteBucket } from "@/lib/api";
import { useKv } from "@/store/kv";
import { useToasts } from "@/store/toasts";
import { openKvEntry } from "@/lib/editor";
import { CreateKeyDialog } from "@/components/editor/kv/CreateKeyDialog";
import { ConfirmDialog } from "@/components/editor/jetstream/ConfirmDialog";
import type { KvBucketSummary, KvEntrySummary } from "@/lib/api";

type Row =
  | { kind: "bucket"; bucket: KvBucketSummary }
  | {
      kind: "node";
      bucket: string;
      node: SubjectNode;
      depth: number;
      entry: KvEntrySummary | undefined;
    };

const nodeId = (bucket: string, path: string) => `${bucket}\u0000${path}`;

export function KvTree({
  connId,
  buckets,
}: {
  connId: string;
  buckets: KvBucketSummary[];
}) {
  const expanded = useKv((s) => s.byConn[connId]?.expanded ?? {});
  const keysByBucket = useKv((s) => s.byConn[connId]?.children ?? {});
  const loading = useKv((s) => s.byConn[connId]?.childrenLoading ?? {});
  const toggleBucket = useKv((s) => s.toggle);

  const [openNodes, setOpenNodes] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState(0);
  const [newKeyBucket, setNewKeyBucket] = useState<string | null>(null);
  const [delBucket, setDelBucket] = useState<string | null>(null);

  const doCreateKey = async (bkt: string, key: string, value: string) => {
    try {
      await kvCreate(connId, bkt, key, encodeText(value));
      useToasts.getState().push("success", `Created ${key}`);
      void useKv.getState().refreshChildren(connId, bkt);
      void useKv.getState().load(connId);
    } catch (e) {
      useToasts.getState().push("error", `Create failed: ${String(e)}`);
    }
  };

  const doDeleteBucket = async (bkt: string) => {
    try {
      await kvDeleteBucket(connId, bkt);
      useToasts.getState().push("success", `Deleted bucket ${bkt}`);
      void useKv.getState().load(connId);
    } catch (e) {
      useToasts.getState().push("error", `Delete failed: ${String(e)}`);
    }
  };

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const bucket of buckets) {
      out.push({ kind: "bucket", bucket });
      if (!expanded[bucket.bucket]) continue;
      const keys = keysByBucket[bucket.bucket] ?? [];
      const byKey = new Map(keys.map((k) => [k.key, k]));
      const tree = buildSubjectTree(
        keys.map((k) => ({ subject: k.key, count: 1, rate: 0 })),
      );
      const push = (nodes: SubjectNode[], depth: number) => {
        for (const node of nodes) {
          out.push({
            kind: "node",
            bucket: bucket.bucket,
            node,
            depth,
            entry: byKey.get(node.path),
          });
          if (
            node.children.length &&
            openNodes.has(nodeId(bucket.bucket, node.path))
          ) {
            push(node.children, depth + 1);
          }
        }
      };
      push(tree, 1);
    }
    return out;
  }, [buckets, expanded, keysByBucket, openNodes]);

  const sel = Math.min(selected, rows.length - 1);

  const toggleNode = (bucket: string, path: string) =>
    setOpenNodes((prev) => {
      const next = new Set(prev);
      const id = nodeId(bucket, path);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const activate = (row: Row) => {
    if (row.kind === "bucket") {
      void toggleBucket(connId, row.bucket.bucket);
    } else if (row.entry) {
      openKvEntry(connId, row.bucket, row.node.path);
    } else if (row.node.children.length) {
      toggleNode(row.bucket, row.node.path);
    }
  };

  const isOpen = (row: Row) =>
    row.kind === "bucket"
      ? !!expanded[row.bucket.bucket]
      : openNodes.has(nodeId(row.bucket, row.node.path));

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
      if (row) activate(row);
    } else if (e.key === "ArrowRight" && row && !isOpen(row)) {
      if (row.kind === "bucket" || row.node.children.length) {
        e.preventDefault();
        activate(row);
      }
    } else if (e.key === "ArrowLeft" && row && isOpen(row)) {
      e.preventDefault();
      if (row.kind === "bucket") void toggleBucket(connId, row.bucket.bucket);
      else toggleNode(row.bucket, row.node.path);
    }
  };

  return (
    <>
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
              onNewKey={() => setNewKeyBucket(row.bucket.bucket)}
              onDelete={() => setDelBucket(row.bucket.bucket)}
            />
          ) : (
            <NodeRow
              key={`n:${row.bucket}:${row.node.path}`}
              row={row}
              selected={i === sel}
              open={openNodes.has(nodeId(row.bucket, row.node.path))}
              onSelect={() => setSelected(i)}
              onToggle={() => toggleNode(row.bucket, row.node.path)}
              onOpen={() => {
                if (row.entry) openKvEntry(connId, row.bucket, row.node.path);
              }}
            />
          ),
        )}
      </ul>

      {newKeyBucket && (
        <CreateKeyDialog
          bucket={newKeyBucket}
          onClose={() => setNewKeyBucket(null)}
          onCreate={(key, value) => void doCreateKey(newKeyBucket, key, value)}
        />
      )}
      {delBucket && (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setDelBucket(null);
          }}
          title={`Delete bucket ${delBucket}?`}
          description="This permanently deletes the bucket and all its keys. This can't be undone."
          confirmLabel="Delete bucket"
          confirmWord={delBucket}
          onConfirm={() => void doDeleteBucket(delBucket)}
        />
      )}
    </>
  );
}

function BucketRow({
  bucket,
  selected,
  expanded,
  loading,
  onSelect,
  onToggle,
  onNewKey,
  onDelete,
}: {
  bucket: KvBucketSummary;
  selected: boolean;
  expanded: boolean;
  loading: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onNewKey: () => void;
  onDelete: () => void;
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
        selected ? "bg-selected" : "hover:bg-row-hover",
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
      <Database className="size-3 shrink-0 text-brand" />
      <span className="min-w-0 flex-1 truncate font-mono">{bucket.bucket}</span>
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
        <button
          type="button"
          aria-label="New key"
          title="New key"
          onClick={(e) => {
            e.stopPropagation();
            onNewKey();
          }}
          className="text-muted-foreground hover:text-foreground"
        >
          <Plus className="size-3" />
        </button>
        <button
          type="button"
          aria-label="Delete bucket"
          title="Delete bucket"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="text-muted-foreground hover:text-error"
        >
          <Trash2 className="size-3" />
        </button>
      </span>
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
        {fmtCount(bucket.values)} · {fmtBytes(bucket.bytes)} · {bucket.storage}
      </span>
    </li>
  );
}

function NodeRow({
  row,
  selected,
  open,
  onSelect,
  onToggle,
  onOpen,
}: {
  row: Extract<Row, { kind: "node" }>;
  selected: boolean;
  open: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const isFolder = row.node.children.length > 0;
  const isKey = !!row.entry;
  const deleted = row.entry && row.entry.operation !== "put";
  return (
    <li
      role="treeitem"
      aria-selected={selected}
      onClick={onSelect}
      onDoubleClick={onOpen}
      style={{ paddingLeft: `${String(row.depth * 0.85 + 0.5)}rem` }}
      className={cn(
        "group relative flex cursor-pointer items-center gap-1 py-1 pr-2 text-xs",
        selected ? "bg-selected" : "hover:bg-row-hover",
      )}
    >
      {selected && (
        <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-brand" />
      )}
      {isFolder ? (
        <button
          type="button"
          aria-label={open ? "Collapse" : "Expand"}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
        >
          <ChevronRight
            className={cn("size-3 transition-transform", open && "rotate-90")}
          />
        </button>
      ) : (
        <span className="size-4 shrink-0" />
      )}
      {isKey ? (
        <Key className="size-3 shrink-0 text-muted-foreground" />
      ) : (
        <Folder className="size-3 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate font-mono">
        {row.node.token}
      </span>
      {deleted && <Trash2 className="size-3 shrink-0 text-warn" />}
      {isKey && row.entry ? (
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          r{row.entry.revision} · {fmtBytes(row.entry.size)}
        </span>
      ) : (
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          {fmtCount(row.node.count)}
        </span>
      )}
    </li>
  );
}
