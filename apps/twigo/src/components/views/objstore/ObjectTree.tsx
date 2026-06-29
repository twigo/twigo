import { useMemo, useRef, useState } from "react";
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
import { VirtualTree } from "@/components/views/VirtualTree";
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

  const activate = (row: Row) => {
    if (row.kind === "bucket") void toggleBucket(connId, row.bucket.bucket);
    else openObjectEntry(connId, row.bucket, row.object.name);
  };
  // null = not expandable (objects are leaves).
  const rowExpanded = (row: Row): boolean | null =>
    row.kind === "bucket" ? !!expanded[row.bucket.bucket] : null;
  const toggleRow = (row: Row) => {
    if (row.kind === "bucket") void toggleBucket(connId, row.bucket.bucket);
  };

  return (
    <>
      <VirtualTree
        rows={rows}
        rowKey={(row) =>
          row.kind === "bucket"
            ? `b:${row.bucket.bucket}`
            : `o:${row.bucket}:${row.object.name}`
        }
        nav={{
          onActivate: activate,
          expanded: rowExpanded,
          onExpand: toggleRow,
          onCollapse: toggleRow,
        }}
        renderRow={(row, selected) =>
          row.kind === "bucket" ? (
            <BucketRow
              bucket={row.bucket}
              selected={selected}
              expanded={!!expanded[row.bucket.bucket]}
              loading={!!loading[row.bucket.bucket]}
              uploading={uploadingBucket === row.bucket.bucket}
              readOnly={readOnly}
              onToggle={() => void toggleBucket(connId, row.bucket.bucket)}
              onUpload={() => void startUpload(row.bucket.bucket)}
              onDelete={() => setDelBucket(row.bucket.bucket)}
            />
          ) : (
            <ObjectRow object={row.object} selected={selected} />
          )
        }
      />

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
  readOnly,
  onToggle,
  onUpload,
  onDelete,
}: {
  bucket: ObjBucketSummary;
  selected: boolean;
  expanded: boolean;
  loading: boolean;
  uploading: boolean;
  readOnly: boolean;
  onToggle: () => void;
  onUpload: () => void;
  onDelete: () => void;
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
    </div>
  );
}

function ObjectRow({
  object,
  selected,
}: {
  object: ObjSummary;
  selected: boolean;
}) {
  return (
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
  );
}
