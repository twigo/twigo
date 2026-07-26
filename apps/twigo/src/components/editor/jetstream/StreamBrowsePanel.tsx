import { useEffect, useMemo, useState } from "react";
import { Allotment } from "allotment";
import { Layers, RefreshCw, Loader2, Trash2, History } from "lucide-react";
import { Button, EmptyState, cn } from "@twigo/ui";
import { decodePreview, type StreamMessage } from "@twigo/utils";
import {
  jsGetMessages,
  jsDeleteMessage,
  jsCreateConsumer,
  type StoredMessage,
  type MessagePage,
} from "@/lib/api";
import { messageMatches } from "@/lib/messageFilter";
import { useIsReadOnly } from "@/hooks/useIsReadOnly";
import { useJetStream } from "@/store/jetstream";
import { useToasts } from "@/store/toasts";
import { MessageTable } from "../MessageTable";
import { MessageInspector } from "../DetailPanel";
import { ConfirmDialog } from "./ConfirmDialog";
import { CreateConsumerDialog } from "./CreateConsumerDialog";

const PAGE = 50;

// After deleting a row, keep the selection inside the *filtered* view the user
// actually sees: prefer the row that slid into the deleted slot, else the
// previous one. (Indexing the unfiltered list here selected a hidden row.)
export function nextSelectionAfterDelete(
  shown: { seq: number }[],
  deletedSeq: number,
): number | null {
  const idx = shown.findIndex((m) => m.seq === deletedSeq);
  const rest = shown.filter((m) => m.seq !== deletedSeq);
  return rest[idx]?.seq ?? rest[idx - 1]?.seq ?? null;
}

// A stored message has a sequence and a server timestamp where a live one has an
// arrival id; everything the inspector reads is otherwise the same shape.
function toStreamMessage(m: StoredMessage): StreamMessage {
  const at = m.time ? Date.parse(m.time) : NaN;
  return {
    id: m.seq,
    receivedAt: Number.isFinite(at) ? at : 0,
    subject: m.subject,
    reply: null,
    payloadB64: m.payloadB64,
    headers: m.headers,
    size: m.size,
    preview: decodePreview(m.payloadB64),
  };
}

// Browsing a stream is the same table + inspector as a live subscription - only
// the source differs (a paged, non-destructive walk instead of a subscription).
// It never creates a consumer and never advances an ack floor.
export function StreamBrowsePanel({
  connId,
  stream,
}: {
  connId: string;
  stream: string;
}) {
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [nextSeq, setNextSeq] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [seqInput, setSeqInput] = useState("");
  const [filter, setFilter] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [replayFrom, setReplayFrom] = useState<number | null>(null);
  const readOnly = useIsReadOnly(connId);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  const applyPage = (page: MessagePage, append: boolean) => {
    setMessages((prev) =>
      append ? [...prev, ...page.messages] : page.messages,
    );
    setNextSeq(page.nextSeq);
    if (!append) setSelectedSeq(page.messages[0]?.seq ?? null);
  };

  const load = async (start: number | null, append: boolean) => {
    setLoading(true);
    setError(null);
    try {
      applyPage(await jsGetMessages(connId, stream, start, PAGE, true), append);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  // The first page loads without touching state synchronously - `loading`
  // already starts true, so there is nothing to set on the way in.
  useEffect(() => {
    let cancelled = false;
    jsGetMessages(connId, stream, null, PAGE, true)
      .then((page) => {
        if (!cancelled) applyPage(page, false);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connId, stream]);

  const shown = useMemo(() => {
    const ff = filter.trim();
    const rows = ff
      ? messages.filter((m) =>
          messageMatches(m.subject, decodePreview(m.payloadB64), filter),
        )
      : messages;
    return rows.map(toStreamMessage);
  }, [messages, filter]);

  const selected = messages.find((m) => m.seq === selectedSeq);
  const selectedRow = shown.find((m) => m.id === selectedSeq);

  const doDelete = async (seq: number) => {
    try {
      await jsDeleteMessage(connId, stream, seq);
      setSelectedSeq(
        nextSelectionAfterDelete(
          shown.map((m) => ({ seq: m.id })),
          seq,
        ),
      );
      setMessages((prev) => prev.filter((m) => m.seq !== seq));
      useToasts.getState().push("success", `Deleted message #${String(seq)}`);
      void useJetStream.getState().load(connId);
    } catch (e) {
      useToasts.getState().push("error", `Delete failed: ${String(e)}`);
    }
  };

  const doCreateConsumer = async (config: Record<string, unknown>) => {
    try {
      await jsCreateConsumer(connId, stream, config);
      useToasts.getState().push("success", "Consumer created");
      void useJetStream.getState().refreshChildren(connId, stream);
    } catch (e) {
      useToasts.getState().push("error", `Create failed: ${String(e)}`);
    }
  };

  const jumpToSeq = () => {
    const n = Number(seqInput);
    if (Number.isFinite(n) && n > 0) void load(Math.floor(n), false);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-editor">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
        <Layers className="size-3.5 text-brand" />
        <span className="truncate font-mono text-[11px] font-medium">
          {stream}
        </span>
        <span className="text-[11px] text-muted-foreground">messages</span>
        <div className="ml-auto flex items-center gap-1">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter…"
            aria-label="Filter messages"
            className="h-6 w-32 rounded border border-border bg-background px-1.5 text-xs"
          />
          <input
            value={seqInput}
            onChange={(e) => setSeqInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") jumpToSeq();
            }}
            inputMode="numeric"
            placeholder="seq…"
            aria-label="Browse from sequence"
            className="h-6 w-20 rounded border border-border bg-background px-1.5 font-mono text-xs"
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Load latest"
            title="Load latest"
            onClick={() => void load(null, false)}
          >
            <RefreshCw className={cn(loading && "animate-spin")} />
          </Button>
        </div>
      </div>

      {error ? (
        <EmptyState
          icon={Layers}
          variant="error"
          className="flex-1"
          action={{
            label: "Retry",
            onClick: () => void load(null, false),
            icon: RefreshCw,
          }}
        >
          <span className="max-w-md break-words">{error}</span>
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState icon={Layers} className="flex-1">
          {loading
            ? "Reading messages…"
            : messages.length === 0
              ? "No messages in this stream."
              : `No messages match “${filter.trim()}”.`}
        </EmptyState>
      ) : (
        <Allotment className="min-h-0 flex-1" proportionalLayout={false}>
          <Allotment.Pane minSize={320}>
            <div ref={setScrollEl} className="h-full overflow-auto">
              <MessageTable
                items={shown}
                selectedId={selectedSeq}
                scrollEl={scrollEl}
                onSelect={setSelectedSeq}
              />
              {nextSeq !== null && (
                <div className="flex justify-center p-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loading}
                    onClick={() => void load(nextSeq, true)}
                  >
                    {loading && <Loader2 className="animate-spin" />}
                    Load older
                  </Button>
                </div>
              )}
            </div>
          </Allotment.Pane>
          <Allotment.Pane preferredSize={420} minSize={260}>
            <MessageInspector
              msg={selectedRow}
              connId={connId}
              onClose={() => setSelectedSeq(null)}
              fields={
                selected?.truncated ? (
                  <span className="text-[10px] text-warn">
                    Payload truncated to 1 MB for display.
                  </span>
                ) : null
              }
              actions={
                selected && (
                  <>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Replay from here"
                      tooltip="New consumer starting at this sequence"
                      onClick={() => setReplayFrom(selected.seq)}
                    >
                      <History />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Delete message"
                      tooltip={
                        readOnly ? "Connection is read-only" : "Delete message"
                      }
                      className="text-error"
                      disabled={readOnly}
                      onClick={() => setDeleteOpen(true)}
                    >
                      <Trash2 />
                    </Button>
                  </>
                )
              }
            />
          </Allotment.Pane>
        </Allotment>
      )}

      {selected && (
        <ConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title={`Delete message #${String(selected.seq)}?`}
          description="This permanently removes the message from the stream. This can't be undone."
          confirmLabel="Delete message"
          onConfirm={() => void doDelete(selected.seq)}
        />
      )}

      {replayFrom !== null && (
        <CreateConsumerDialog
          stream={stream}
          initialStartSeq={replayFrom}
          onClose={() => setReplayFrom(null)}
          onCreate={(config) => void doCreateConsumer(config)}
        />
      )}
    </div>
  );
}
