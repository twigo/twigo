import { useState } from "react";
import {
  RefreshCw,
  Loader2,
  Database,
  History,
  Pencil,
  Trash2,
  Eraser,
  Save,
  X,
} from "lucide-react";
import {
  Button,
  EmptyState,
  CodeViewer,
  cn,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@twigo/ui";
import {
  fmtBytes,
  fmtDuration,
  decodeText,
  encodeText,
  tryPrettyJson,
  toHex,
} from "@twigo/utils";
import { kvPut, kvDelete, kvPurge } from "@/lib/api";
import { useKvEntry, useKvBucketInfo, useKvHistory } from "@/hooks/useKvDetail";
import { useIsReadOnly } from "@/hooks/useIsReadOnly";
import { useKv } from "@/store/kv";
import { useToasts } from "@/store/toasts";
import { closeKvEntry } from "@/lib/editor";
import { Row, Section } from "@/components/editor/jetstream/parts";
import { ConfirmDialog } from "@/components/editor/jetstream/ConfirmDialog";
import { FormatToggle, type PayloadFormat } from "../FormatToggle";

export function KvEntryDetailPanel({
  connId,
  bucket,
  kvkey,
}: {
  connId: string;
  bucket: string;
  kvkey: string;
}) {
  const [revision, setRevision] = useState<number | null>(null);
  const [format, setFormat] = useState<PayloadFormat>("json");
  const [histKey, setHistKey] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [conflict, setConflict] = useState(false);
  const readOnly = useIsReadOnly(connId);

  const { data, error, loading, refresh } = useKvEntry(
    connId,
    bucket,
    kvkey,
    revision,
  );
  const info = useKvBucketInfo(connId, bucket);
  const history = useKvHistory(connId, bucket, kvkey, histKey);

  const doRefresh = () => {
    setRevision(null);
    setHistKey((k) => k + 1);
    setEditing(false);
    setConflict(false);
    refresh();
  };

  // A value is only safe to edit as text if it isn't truncated and survives a
  // UTF-8 round-trip (otherwise saving would silently lose data or corrupt
  // non-UTF-8 bytes).
  const editable =
    !!data &&
    !data.truncated &&
    encodeText(decodeText(data.payloadB64)) === data.payloadB64;

  const startEdit = () => {
    if (!data || !editable) return;
    setDraft(decodeText(data.payloadB64));
    setFormat("text");
    setEditing(true);
  };

  // useRevision=true → optimistic CAS; false → force overwrite (blind put).
  const save = async (useRevision: boolean) => {
    if (!data) return;
    // The value as loaded - re-putting it is a real "undo" (KV keeps history).
    const prevB64 = data.payloadB64;
    try {
      await kvPut(
        connId,
        bucket,
        kvkey,
        encodeText(draft),
        useRevision ? data.revision : null,
      );
      useToasts.getState().push("success", `Saved ${kvkey}`, {
        label: "Undo",
        run: () => {
          void kvPut(connId, bucket, kvkey, prevB64, null)
            .then(() => {
              useToasts.getState().push("info", `Restored ${kvkey}`);
              doRefresh();
            })
            .catch((e: unknown) => {
              useToasts.getState().push("error", `Undo failed: ${String(e)}`);
            });
        },
      });
      doRefresh();
    } catch (e) {
      const msg = String(e);
      if (/wrong last sequence|revision|expected/i.test(msg)) {
        setConflict(true);
      } else {
        useToasts.getState().push("error", `Save failed: ${msg}`);
      }
    }
  };

  const doDelete = async () => {
    try {
      await kvDelete(connId, bucket, kvkey);
      useToasts.getState().push("success", `Deleted ${kvkey}`);
      closeKvEntry(connId, bucket, kvkey);
      void useKv.getState().refreshChildren(connId, bucket);
      void useKv.getState().load(connId);
    } catch (e) {
      useToasts.getState().push("error", `Delete failed: ${String(e)}`);
    }
  };

  const doPurge = async () => {
    try {
      await kvPurge(connId, bucket, kvkey);
      useToasts.getState().push("success", `Purged ${kvkey}`);
      closeKvEntry(connId, bucket, kvkey);
      void useKv.getState().refreshChildren(connId, bucket);
      void useKv.getState().load(connId);
    } catch (e) {
      useToasts.getState().push("error", `Purge failed: ${String(e)}`);
    }
  };

  const body = data
    ? format === "hex"
      ? toHex(data.payloadB64)
      : format === "text"
        ? decodeText(data.payloadB64)
        : (tryPrettyJson(data.payloadB64) ?? decodeText(data.payloadB64))
    : "";

  return (
    <div className="flex h-full min-h-0 flex-col bg-editor">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <Database className="size-3.5 text-brand" />
        <span className="ml-1 truncate font-mono text-[11px] font-medium">
          {bucket} / {kvkey}
        </span>
        {revision !== null && (
          <span className="ml-1 text-[11px] text-warn">
            · r{revision} (read-only)
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {editing ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Save"
                title={
                  readOnly ? "Connection is read-only" : "Save (optimistic)"
                }
                disabled={readOnly}
                onClick={() => void save(true)}
              >
                <Save />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Cancel edit"
                title="Cancel"
                onClick={() => setEditing(false)}
              >
                <X />
              </Button>
            </>
          ) : (
            data &&
            revision === null && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Edit value"
                  title={
                    readOnly
                      ? "Connection is read-only"
                      : editable
                        ? "Edit value"
                        : "Can't edit a truncated or non-UTF-8 value"
                  }
                  disabled={!editable || readOnly}
                  onClick={startEdit}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Delete key"
                  title={
                    readOnly
                      ? "Connection is read-only"
                      : "Delete key (tombstone)"
                  }
                  className="text-error"
                  disabled={readOnly}
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Purge key"
                  title={
                    readOnly
                      ? "Connection is read-only"
                      : "Purge key (wipe history)"
                  }
                  className="text-error"
                  disabled={readOnly}
                  onClick={() => setPurgeOpen(true)}
                >
                  <Eraser />
                </Button>
              </>
            )
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh"
            title="Refresh"
            onClick={doRefresh}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete key ${kvkey}?`}
        description="This writes a delete marker (tombstone); history is retained until purged."
        confirmLabel="Delete key"
        onConfirm={() => void doDelete()}
      />
      <ConfirmDialog
        open={purgeOpen}
        onOpenChange={setPurgeOpen}
        title={`Purge key ${kvkey}?`}
        description="This permanently wipes the key and all its history. This can't be undone."
        confirmLabel="Purge key"
        confirmWord={kvkey}
        onConfirm={() => void doPurge()}
      />

      <Dialog open={conflict} onOpenChange={setConflict}>
        <DialogContent className="p-4">
          <DialogTitle className="text-sm font-semibold">
            {kvkey} changed
          </DialogTitle>
          <DialogDescription className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            The key was updated by someone else since you opened it. Reload to
            see their value (discards your edit), or overwrite it with yours.
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => doRefresh()}>
              Reload
            </Button>
            <Button
              variant="destructive"
              size="sm"
              title={readOnly ? "Connection is read-only" : undefined}
              disabled={readOnly}
              onClick={() => void save(false)}
            >
              Overwrite
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {error ? (
        <EmptyState icon={Database} variant="error" className="flex-1 gap-3">
          <span className="max-w-72 break-words">{error}</span>
          <Button variant="outline" size="sm" onClick={doRefresh}>
            <RefreshCw />
            Retry
          </Button>
        </EmptyState>
      ) : !data ? (
        loading ? (
          <EmptyState
            icon={Loader2}
            className="flex-1"
            iconClassName="animate-spin"
          >
            Loading…
          </EmptyState>
        ) : (
          <EmptyState icon={Database} className="flex-1">
            Key not found.
          </EmptyState>
        )
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3">
          <div className="flex flex-col gap-1.5">
            {editing ? (
              <span className="text-[10px] font-semibold uppercase tracking-wider text-brand">
                Editing value
              </span>
            ) : (
              <FormatToggle value={format} onChange={setFormat} />
            )}
            {data.truncated && !editing && (
              <p className="text-[10px] text-warn">
                Value truncated to 1 MB for display · {fmtBytes(data.size)}{" "}
                total.
              </p>
            )}
            {editing ? (
              <CodeViewer
                value={draft}
                onChange={setDraft}
                language="text"
                className="max-h-72"
              />
            ) : (
              <CodeViewer
                value={body}
                language={format === "json" ? "json" : "text"}
                className="max-h-72"
              />
            )}
          </div>

          <Section title="Entry">
            <Row label="Revision" value={data.revision} />
            <Row label="Created" value={data.created ?? "-"} />
            <Row
              label="Operation"
              value={
                <span className={data.operation !== "put" ? "text-warn" : ""}>
                  {data.operation}
                </span>
              }
            />
            <Row label="Size" value={fmtBytes(data.size)} />
          </Section>

          {info && (
            <Section title="Bucket">
              <Row label="History depth" value={info.history} />
              <Row label="TTL" value={fmtDuration(info.maxAge)} />
              <Row
                label="Max value size"
                value={
                  info.maxValueSize < 0 ? "∞" : fmtBytes(info.maxValueSize)
                }
              />
              <Row label="Storage" value={info.storage} />
              <Row label="Replicas" value={info.replicas} />
            </Section>
          )}

          <section>
            <h3 className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <History className="size-3.5" />
              History
              {revision !== null && (
                <button
                  type="button"
                  onClick={() => setRevision(null)}
                  className="ml-auto text-brand hover:underline"
                >
                  back to latest
                </button>
              )}
            </h3>
            <ul className="max-h-48 overflow-auto rounded-md border border-border">
              {history.length === 0 ? (
                <li className="px-2 py-1 text-[11px] text-muted-foreground">
                  No history.
                </li>
              ) : (
                history.map((h) => (
                  <li key={h.revision}>
                    <button
                      type="button"
                      onClick={() => setRevision(h.revision)}
                      className={cn(
                        "flex w-full items-center gap-2 border-b border-border/50 px-2 py-1 text-left font-mono text-[11px] last:border-0 hover:bg-row-hover",
                        (revision ?? data.revision) === h.revision &&
                          "bg-accent",
                      )}
                    >
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        r{h.revision}
                      </span>
                      <span
                        className={cn(
                          "shrink-0",
                          h.operation !== "put"
                            ? "text-warn"
                            : "text-muted-foreground",
                        )}
                      >
                        {h.operation}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">
                        {h.created ?? ""}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}
