import { useState } from "react";
import { RefreshCw, Loader2, Box, Download, Trash2 } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { Button, EmptyState } from "@twigo/ui";
import { fmtBytes, fmtCount } from "@twigo/utils";
import { objGetObject, objDelete } from "@/lib/api";
import { useObjectInfo } from "@/hooks/useObjectInfo";
import { useObjStore } from "@/store/objstore";
import { useToasts } from "@/store/toasts";
import { closeObjectEntry } from "@/lib/editor";
import { Row, Section } from "@/components/editor/jetstream/parts";
import { ConfirmDialog } from "@/components/editor/jetstream/ConfirmDialog";

export function ObjectDetailPanel({
  connId,
  bucket,
  name,
}: {
  connId: string;
  bucket: string;
  name: string;
}) {
  const { data, error, loading, refresh } = useObjectInfo(connId, bucket, name);
  const meta = data ? Object.entries(data.metadata) : [];
  const [downloading, setDownloading] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const doDownload = async () => {
    const dest = await save({ defaultPath: name.split("/").pop() });
    if (!dest) return;
    setDownloading(true);
    try {
      await objGetObject(connId, bucket, name, dest);
      useToasts.getState().push("info", `Saved ${name}`);
    } catch (e) {
      useToasts.getState().push("error", `Download failed: ${String(e)}`);
    } finally {
      setDownloading(false);
    }
  };

  const doDelete = async () => {
    try {
      await objDelete(connId, bucket, name);
      useToasts.getState().push("info", `Deleted ${name}`);
      closeObjectEntry(connId, bucket, name);
      void useObjStore.getState().refreshObjects(connId, bucket);
      void useObjStore.getState().load(connId);
    } catch (e) {
      useToasts.getState().push("error", `Delete failed: ${String(e)}`);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <Box className="size-3.5 text-brand" />
        <span className="ml-1 truncate font-mono text-[11px] font-medium">
          {bucket} / {name}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          {data && !data.deleted && (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Download"
                title="Download to disk"
                disabled={downloading}
                onClick={() => void doDownload()}
              >
                <Download className={downloading ? "animate-pulse" : ""} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Delete object"
                title="Delete object"
                className="text-error"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 />
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh"
            title="Refresh"
            onClick={refresh}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete object ${name}?`}
        description="This removes the object from the store. This can't be undone."
        confirmLabel="Delete object"
        onConfirm={() => void doDelete()}
      />

      {error ? (
        <EmptyState icon={Box} variant="error" className="flex-1 gap-3">
          <span className="max-w-72 break-words">{error}</span>
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCw />
            Retry
          </Button>
        </EmptyState>
      ) : !data ? (
        <EmptyState icon={Loader2} className="flex-1 [&>svg]:animate-spin">
          Loading…
        </EmptyState>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3">
          <Section title="Object">
            <Row label="Size" value={fmtBytes(data.size)} />
            <Row label="Chunks" value={fmtCount(data.chunks)} />
            <Row label="Modified" value={data.modified ?? "—"} />
            <Row
              label="Digest"
              value={<span className="truncate">{data.digest ?? "—"}</span>}
            />
            <Row
              label="Deleted"
              value={
                <span className={data.deleted ? "text-warn" : ""}>
                  {data.deleted ? "yes" : "no"}
                </span>
              }
            />
            {data.description && (
              <Row label="Description" value={data.description} />
            )}
          </Section>

          {meta.length > 0 && (
            <Section title="Metadata">
              {meta.map(([k, v]) => (
                <Row key={k} label={k} value={v} />
              ))}
            </Section>
          )}

          {data.headers.length > 0 && (
            <Section title="Headers">
              {data.headers.map(([k, v], i) => (
                <Row key={`${k}:${String(i)}`} label={k} value={v} />
              ))}
            </Section>
          )}
        </div>
      )}
    </div>
  );
}
