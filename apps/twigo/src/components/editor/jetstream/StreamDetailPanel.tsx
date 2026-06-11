import { useState } from "react";
import { RefreshCw, Loader2, Layers, Eraser, Trash2 } from "lucide-react";
import { Button, EmptyState } from "@twigo/ui";
import { fmtBytes, fmtCount } from "@twigo/utils";
import { jsPurgeStream, jsDeleteStream } from "@/lib/api";
import { useStreamDetail } from "@/hooks/useJetStreamDetail";
import { useJetStream } from "@/store/jetstream";
import { useToasts } from "@/store/toasts";
import { closeStreamDetail } from "@/lib/editor";
import { Row, Section, RawJson } from "./parts";
import { disp, num, limitCount, limitBytes } from "./format";
import { MessageBrowser } from "./MessageBrowser";
import { PurgeDialog } from "./PurgeDialog";
import { ConfirmDialog } from "./ConfirmDialog";

function nanos(v: unknown): string {
  const n = num(v);
  if (n === null) return "—";
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
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const cfg = data?.config ?? {};
  const subjects = Array.isArray(cfg.subjects)
    ? (cfg.subjects as string[])
    : [];
  const denyPurge = !!cfg.deny_purge || !!cfg.sealed;
  const denyDelete = !!cfg.deny_delete || !!cfg.sealed;

  const doPurge = async (keep: number | null) => {
    try {
      const { purged } = await jsPurgeStream(connId, stream, keep, null);
      useToasts
        .getState()
        .push("info", `Purged ${String(purged)} messages from ${stream}`);
      refresh();
      void useJetStream.getState().load(connId);
    } catch (e) {
      useToasts.getState().push("error", `Purge failed: ${String(e)}`);
    }
  };

  const doDelete = async () => {
    try {
      await jsDeleteStream(connId, stream);
      useToasts.getState().push("info", `Deleted stream ${stream}`);
      closeStreamDetail(connId, stream);
      void useJetStream.getState().load(connId);
    } catch (e) {
      useToasts.getState().push("error", `Delete failed: ${String(e)}`);
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
                aria-label="Purge messages"
                title={
                  denyPurge ? "Purge denied on this stream" : "Purge messages"
                }
                disabled={denyPurge}
                onClick={() => setPurgeOpen(true)}
              >
                <Eraser />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Delete stream"
                title={
                  denyDelete
                    ? "Delete denied (sealed/deny-delete)"
                    : "Delete stream"
                }
                disabled={denyDelete}
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
              value={subjects.length ? subjects.join(", ") : "—"}
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
