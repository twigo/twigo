import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, Box, File, Loader2, Trash2, Upload } from "lucide-react";
import { cn } from "@twigo/ui";
import { fmtBytes, fmtCount } from "@twigo/utils";
import {
  objStageUpload,
  objCommitUpload,
  objCancelUpload,
  objDeleteBucket,
} from "@/lib/api";
import { useObjStore } from "@/store/objstore";
import { useToasts } from "@/store/toasts";
import { useIsReadOnly } from "@/hooks/useIsReadOnly";
import { openObjectEntry } from "@/lib/editor";
import { ConfirmDialog } from "@/components/editor/jetstream/ConfirmDialog";
import type { ObjBucketSummary, ObjSummary } from "@/lib/api";

type Row =
  | { kind: "bucket"; bucket: ObjBucketSummary }
  | { kind: "object"; bucket: string; object: ObjSummary };

const ROW_H = 26;

export function ObjectTree({
  connId,
  buckets,
}: {
  connId: string;
  buckets: ObjBucketSummary[];
}) {
  const expanded = useObjStore((s) => s.byConn[connId]?.expanded ?? {});
  const objectsByBucket = useObjStore((s) => s.byConn[connId]?.children ?? {});
  const loading = useObjStore((s) => s.byConn[connId]?.childrenLoading ?? {});
  const toggleBucket = useObjStore((s) => s.toggle);
  const readOnly = useIsReadOnly(connId);

  const [selected, setSelected] = useState(0);
  const [delBucket, setDelBucket] = useState<string | null>(null);
  const [uploadingBucket, setUploadingBucket] = useState<string | null>(null);
  const [pendingUpload, setPendingUpload] = useState<{
    bucket: string;
    name: string;
  } | null>(null);
  // ConfirmDialog fires onConfirm then onOpenChange(false); this flag lets the
  // dismiss handler skip cancelling the staged upload that was just committed.
  const confirmedRef = useRef(false);

  const commitUpload = async (bkt: string) => {
    setUploadingBucket(bkt);
    try {
      const name = await objCommitUpload(connId);
      if (name) {
        useToasts.getState().push("success", `Uploaded ${name}`);
        void useObjStore.getState().refreshChildren(connId, bkt);
        void useObjStore.getState().load(connId);
      }
    } catch (e) {
      useToasts.getState().push("error", `Upload failed: ${String(e)}`);
    } finally {
      setUploadingBucket(null);
    }
  };

  const startUpload = async (bkt: string) => {
    // null = the user cancelled the Rust-side picker.
    let staged;
    try {
      staged = await objStageUpload(connId, bkt);
    } catch (e) {
      useToasts.getState().push("error", `Upload failed: ${String(e)}`);
      return;
    }
    if (!staged) return;
    // Object store put() replaces; warn before clobbering an existing object.
    if (staged.exists) {
      setPendingUpload({ bucket: bkt, name: staged.name });
    } else {
      await commitUpload(bkt);
    }
  };

  const doDeleteBucket = async (bkt: string) => {
    try {
      await objDeleteBucket(connId, bkt);
      useToasts.getState().push("success", `Deleted object store ${bkt}`);
      void useObjStore.getState().load(connId);
    } catch (e) {
      useToasts.getState().push("error", `Delete failed: ${String(e)}`);
    }
  };

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

  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_H,
    overscan: 12,
  });
  // Move selection and scroll the target into view (rows unmount when off-screen,
  // so this must drive the scroll - native scroll is preventDefault'd).
  const moveTo = (next: number) => {
    setSelected(next);
    virtualizer.scrollToIndex(next);
  };

  const open = (row: Row) => {
    if (row.kind === "bucket") void toggleBucket(connId, row.bucket.bucket);
    else openObjectEntry(connId, row.bucket, row.object.name);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const row = rows[sel];
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveTo(Math.min(sel + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveTo(Math.max(sel - 1, 0));
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
    <>
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
            return row.kind === "bucket" ? (
              <BucketRow
                key={v.key}
                bucket={row.bucket}
                selected={i === sel}
                expanded={!!expanded[row.bucket.bucket]}
                loading={!!loading[row.bucket.bucket]}
                style={style}
                onSelect={() => setSelected(i)}
                onToggle={() => void toggleBucket(connId, row.bucket.bucket)}
                uploading={uploadingBucket === row.bucket.bucket}
                onUpload={() => void startUpload(row.bucket.bucket)}
                onDelete={() => setDelBucket(row.bucket.bucket)}
                readOnly={readOnly}
              />
            ) : (
              <ObjectRow
                key={v.key}
                object={row.object}
                selected={i === sel}
                style={style}
                onSelect={() => setSelected(i)}
                onOpen={() =>
                  openObjectEntry(connId, row.bucket, row.object.name)
                }
              />
            );
          })}
        </ul>
      </div>

      {delBucket && (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setDelBucket(null);
          }}
          title={`Delete object store ${delBucket}?`}
          description="This permanently deletes the store and all its objects. This can't be undone."
          confirmLabel="Delete store"
          confirmWord={delBucket}
          onConfirm={() => void doDeleteBucket(delBucket)}
        />
      )}

      {pendingUpload && (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (o) return;
            // Dismissed without confirming -> drop the staged file backend-side.
            if (!confirmedRef.current) void objCancelUpload();
            confirmedRef.current = false;
            setPendingUpload(null);
          }}
          title={`Replace ${pendingUpload.name}?`}
          description="An object with this name already exists in the store. Uploading replaces it - the current contents are lost."
          confirmLabel="Replace object"
          onConfirm={() => {
            confirmedRef.current = true;
            void commitUpload(pendingUpload.bucket);
          }}
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
  uploading,
  style,
  onSelect,
  onToggle,
  onUpload,
  onDelete,
  readOnly,
}: {
  bucket: ObjBucketSummary;
  selected: boolean;
  expanded: boolean;
  loading: boolean;
  uploading: boolean;
  style: React.CSSProperties;
  onSelect: () => void;
  onToggle: () => void;
  onUpload: () => void;
  onDelete: () => void;
  readOnly: boolean;
}) {
  return (
    <li
      role="treeitem"
      aria-selected={selected}
      aria-expanded={expanded}
      onClick={onSelect}
      onDoubleClick={onToggle}
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
        <Box className="size-3 shrink-0 text-brand" />
        <span className="min-w-0 flex-1 truncate font-mono">
          {bucket.bucket}
        </span>
        <span
          className={cn(
            "flex shrink-0 items-center gap-0.5",
            uploading ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          <button
            type="button"
            aria-label="Upload object"
            title={readOnly ? "Connection is read-only" : "Upload object"}
            disabled={uploading || readOnly}
            onClick={(e) => {
              e.stopPropagation();
              onUpload();
            }}
            className="text-muted-foreground hover:text-foreground"
          >
            {uploading ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Upload className="size-3" />
            )}
          </button>
          <button
            type="button"
            aria-label="Delete object store"
            title={readOnly ? "Connection is read-only" : "Delete object store"}
            disabled={readOnly}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="text-muted-foreground hover:text-error disabled:opacity-50"
          >
            <Trash2 className="size-3" />
          </button>
        </span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          {fmtBytes(bucket.bytes)} · {bucket.storage}
        </span>
      </div>
    </li>
  );
}

function ObjectRow({
  object,
  selected,
  style,
  onSelect,
  onOpen,
}: {
  object: ObjSummary;
  selected: boolean;
  style: React.CSSProperties;
  onSelect: () => void;
  onOpen: () => void;
}) {
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
        <File className="size-3 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono">{object.name}</span>
        {object.deleted && <Trash2 className="size-3 shrink-0 text-warn" />}
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          {fmtBytes(object.size)} · {fmtCount(object.chunks)} chunks
        </span>
      </div>
    </li>
  );
}
