import { useMemo, useState } from "react";
import { ChevronRight, Box, File, Loader2, Trash2, Upload } from "lucide-react";
import { open as openFile } from "@tauri-apps/plugin-dialog";
import { cn } from "@twigo/ui";
import { fmtBytes, fmtCount } from "@twigo/utils";
import { objPutObject, objDeleteBucket, objObjectInfo } from "@/lib/api";
import { useObjStore } from "@/store/objstore";
import { useToasts } from "@/store/toasts";
import { useIsReadOnly } from "@/hooks/useIsReadOnly";
import { openObjectEntry } from "@/lib/editor";
import { ConfirmDialog } from "@/components/editor/jetstream/ConfirmDialog";
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
  const objectsByBucket = useObjStore((s) => s.byConn[connId]?.children ?? {});
  const loading = useObjStore((s) => s.byConn[connId]?.childrenLoading ?? {});
  const toggleBucket = useObjStore((s) => s.toggle);
  const readOnly = useIsReadOnly(connId);

  const [selected, setSelected] = useState(0);
  const [delBucket, setDelBucket] = useState<string | null>(null);
  const [uploadingBucket, setUploadingBucket] = useState<string | null>(null);
  const [pendingUpload, setPendingUpload] = useState<{
    bucket: string;
    src: string;
    name: string;
  } | null>(null);

  const runUpload = async (bkt: string, src: string, objName: string) => {
    setUploadingBucket(bkt);
    try {
      await objPutObject(connId, bkt, objName, src);
      useToasts.getState().push("success", `Uploaded ${objName}`);
      void useObjStore.getState().refreshChildren(connId, bkt);
      void useObjStore.getState().load(connId);
    } catch (e) {
      useToasts.getState().push("error", `Upload failed: ${String(e)}`);
    } finally {
      setUploadingBucket(null);
    }
  };

  const startUpload = async (bkt: string) => {
    const src = await openFile({ multiple: false, directory: false });
    if (typeof src !== "string") return;
    const objName = src.split(/[\\/]/).filter(Boolean).pop() ?? src;
    // Object store put() replaces; warn before clobbering an existing object.
    try {
      const existing = await objObjectInfo(connId, bkt, objName);
      if (!existing.deleted) {
        setPendingUpload({ bucket: bkt, src, name: objName });
        return;
      }
    } catch {
      // info() errors when the object doesn't exist yet — safe to upload.
    }
    await runUpload(bkt, src, objName);
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
              uploading={uploadingBucket === row.bucket.bucket}
              onUpload={() => void startUpload(row.bucket.bucket)}
              onDelete={() => setDelBucket(row.bucket.bucket)}
              readOnly={readOnly}
            />
          ) : (
            <ObjectRow
              key={`o:${row.bucket}:${row.object.name}`}
              object={row.object}
              selected={i === sel}
              onSelect={() => setSelected(i)}
              onOpen={() =>
                openObjectEntry(connId, row.bucket, row.object.name)
              }
            />
          ),
        )}
      </ul>

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
            if (!o) setPendingUpload(null);
          }}
          title={`Replace ${pendingUpload.name}?`}
          description="An object with this name already exists in the store. Uploading replaces it — the current contents are lost."
          confirmLabel="Replace object"
          onConfirm={() =>
            void runUpload(
              pendingUpload.bucket,
              pendingUpload.src,
              pendingUpload.name,
            )
          }
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
      <Box className="size-3 shrink-0 text-brand" />
      <span className="min-w-0 flex-1 truncate font-mono">{bucket.bucket}</span>
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
        selected ? "bg-selected" : "hover:bg-row-hover",
      )}
    >
      {selected && (
        <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-brand" />
      )}
      <File className="size-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-mono">{object.name}</span>
      {object.deleted && <Trash2 className="size-3 shrink-0 text-warn" />}
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
        {fmtBytes(object.size)} · {fmtCount(object.chunks)} chunks
      </span>
    </li>
  );
}
