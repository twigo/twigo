import { useState } from "react";
import {
  RefreshCw,
  Loader2,
  Layers,
  Eraser,
  Trash2,
  Plus,
  Pencil,
} from "lucide-react";
import { Button, EmptyState } from "@twigo/ui";
import { fmtBytes, fmtCount } from "@twigo/utils";
import {
  jsPurgeStream,
  jsDeleteStream,
  jsCreateConsumer,
  jsUpdateStream,
} from "@/lib/api";
import { useStreamDetail } from "@/hooks/useJetStreamDetail";
import { useIsReadOnly } from "@/hooks/useIsReadOnly";
import { useJetStream } from "@/store/jetstream";
import { useToasts } from "@/store/toasts";
import { closeStreamDetail } from "@/lib/editor";
import { Row, Section, RawJson } from "./parts";
import { disp, num, limitCount, limitBytes } from "./format";
import { MessageBrowser } from "./MessageBrowser";
import { PurgeDialog } from "./PurgeDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { CreateConsumerDialog } from "./CreateConsumerDialog";
import { StreamFormDialog, type StreamFormInitial } from "./StreamFormDialog";

function pick(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function nanos(v: unknown): string {
  const n = num(v);
  if (n === null) return "-";
  if (n <= 0) return "∞";
  return `${Math.round(n / 1e9)}s`;
}

export function StreamDetailPanel({
  connId,
  stream,
}: {
  connId: string;
  stream: string;
}) {
  const { data, error, loading, refresh } = useStreamDetail(connId, stream);
  const readOnly = useIsReadOnly(connId);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [consumerOpen, setConsumerOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const cfg = data?.config ?? {};
  const subjects = Array.isArray(cfg.subjects)
    ? (cfg.subjects as string[])
    : [];
  const denyPurge = !!cfg.deny_purge || !!cfg.sealed;
  const denyDelete = !!cfg.deny_delete || !!cfg.sealed;
  const sealed = !!cfg.sealed;

  const editInitial: StreamFormInitial = {
    name: stream,
    subjects: subjects.join(", "),
    storage: pick(cfg.storage, "file"),
    retention: pick(cfg.retention, "limits"),
    discard: pick(cfg.discard, "old"),
    maxMsgs: String(num(cfg.max_msgs) ?? -1),
    maxBytes: String(num(cfg.max_bytes) ?? -1),
    maxAgeSec: String(Math.round((num(cfg.max_age) ?? 0) / 1e9)),
    replicas: String(num(cfg.num_replicas) ?? 1),
  };

  const doPurge = async (keep: number | null) => {
    try {
      const { purged } = await jsPurgeStream(connId, stream, keep, null);
      useToasts
        .getState()
        .push("success", `Purged ${String(purged)} messages from ${stream}`);
      refresh();
      void useJetStream.getState().load(connId);
    } catch (e) {
      useToasts.getState().push("error", `Purge failed: ${String(e)}`);
    }
  };

  const doDelete = async () => {
    try {
      await jsDeleteStream(connId, stream);
      useToasts.getState().push("success", `Deleted stream ${stream}`);
      closeStreamDetail(connId, stream);
      void useJetStream.getState().load(connId);
    } catch (e) {
      useToasts.getState().push("error", `Delete failed: ${String(e)}`);
    }
  };

  const doCreateConsumer = async (config: Record<string, unknown>) => {
    try {
      await jsCreateConsumer(connId, stream, config);
      useToasts
        .getState()
        .push("success", `Created consumer ${String(config.name)}`);
      void useJetStream.getState().refreshChildren(connId, stream);
      void useJetStream.getState().load(connId);
    } catch (e) {
      useToasts.getState().push("error", `Create failed: ${String(e)}`);
    }
  };

  const doEdit = async (config: Record<string, unknown>) => {
    try {
      await jsUpdateStream(connId, config);
      useToasts.getState().push("success", `Updated stream ${stream}`);
      refresh();
      void useJetStream.getState().load(connId);
    } catch (e) {
      useToasts.getState().push("error", `Update failed: ${String(e)}`);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <Layers className="size-3.5 text-brand" />
        <span className="ml-1 truncate font-mono text-[11px] font-medium">
          {stream}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          {data && (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label="New consumer"
                title={readOnly ? "Connection is read-only" : "New consumer"}
                disabled={readOnly}
                onClick={() => setConsumerOpen(true)}
              >
                <Plus />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Edit stream"
                title={
                  readOnly
                    ? "Connection is read-only"
                    : sealed
                      ? "Sealed streams can't be edited"
                      : "Edit stream"
                }
                disabled={sealed || readOnly}
                onClick={() => setEditOpen(true)}
              >
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Purge messages"
                title={
                  readOnly
                    ? "Connection is read-only"
                    : denyPurge
                      ? "Purge denied on this stream"
                      : "Purge messages"
                }
                disabled={denyPurge || readOnly}
                onClick={() => setPurgeOpen(true)}
              >
                <Eraser />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Delete stream"
                title={
                  readOnly
                    ? "Connection is read-only"
                    : denyDelete
                      ? "Delete denied (sealed/deny-delete)"
                      : "Delete stream"
                }
                disabled={denyDelete || readOnly}
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

      {data && (
        <>
          <PurgeDialog
            open={purgeOpen}
            onOpenChange={setPurgeOpen}
            stream={stream}
            messages={data.messages}
            bytes={data.bytes}
            onPurge={(keep) => void doPurge(keep)}
          />
          <ConfirmDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            title={`Delete stream ${stream}?`}
            description="This permanently deletes the stream with all its messages and consumers. This can't be undone."
            confirmLabel="Delete stream"
            confirmWord={stream}
            onConfirm={() => void doDelete()}
          />
        </>
      )}

      {consumerOpen && (
        <CreateConsumerDialog
          stream={stream}
          onClose={() => setConsumerOpen(false)}
          onCreate={(config) => void doCreateConsumer(config)}
        />
      )}

      {editOpen && (
        <StreamFormDialog
          title={`Edit ${stream}`}
          submitLabel="Save"
          lockIdentity
          initial={editInitial}
          onClose={() => setEditOpen(false)}
          onSubmit={(config) => void doEdit(config)}
        />
      )}

      {error ? (
        <EmptyState icon={Layers} variant="error" className="flex-1 gap-3">
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
          <Section title="State">
            <Row label="Messages" value={fmtCount(data.messages)} />
            <Row label="Bytes" value={fmtBytes(data.bytes)} />
            <Row
              label="First seq"
              value={`${data.firstSeq}${data.firstTs ? ` · ${data.firstTs}` : ""}`}
            />
            <Row
              label="Last seq"
              value={`${data.lastSeq}${data.lastTs ? ` · ${data.lastTs}` : ""}`}
            />
            <Row label="Consumers" value={data.consumerCount} />
            <Row label="Subjects" value={data.numSubjects} />
            <Row label="Deleted" value={data.numDeleted} />
          </Section>

          <Section title="Config">
            <Row
              label="Subjects"
              value={subjects.length ? subjects.join(", ") : "-"}
            />
            <Row label="Retention" value={disp(cfg.retention)} />
            <Row label="Storage" value={disp(cfg.storage)} />
            <Row label="Discard" value={disp(cfg.discard)} />
            <Row label="Replicas" value={num(cfg.num_replicas) ?? 1} />
            <Row label="Max messages" value={limitCount(cfg.max_msgs)} />
            <Row label="Max bytes" value={limitBytes(cfg.max_bytes)} />
            <Row label="Max age" value={nanos(cfg.max_age)} />
            <Row label="Max msg size" value={limitBytes(cfg.max_msg_size)} />
            <Row label="Dup window" value={nanos(cfg.duplicate_window)} />
            <Row label="Allow direct" value={cfg.allow_direct ? "yes" : "no"} />
            <Row label="Sealed" value={cfg.sealed ? "yes" : "no"} />
          </Section>

          <MessageBrowser
            key={`${data.firstSeq}:${data.lastSeq}:${data.messages}`}
            connId={connId}
            stream={stream}
          />

          <RawJson value={data.config} />
        </div>
      )}
    </div>
  );
}
