import { useState } from "react";
import { Copy, Braces, Send, Reply, Pin, PinOff, X } from "lucide-react";
import { Button, EmptyState, CodeViewer, cn } from "@twigo/ui";
import {
  fmtDateTime,
  fmtRelTime,
  fmtBytes,
  type StreamMessage,
} from "@twigo/utils";
import { useStream, type StreamSession } from "@/store/stream";
import { useCompare } from "@/store/compare";
import { openPublish } from "@/lib/editor";
import { defaultTarget, type DecodeTarget } from "@/lib/codecs";
import { useDecodedPayload } from "@/hooks/useDecodedPayload";
import { PayloadDiff } from "./PayloadDiff";
import { PayloadFormatBar } from "./PayloadFormatBar";

// Resolve the selected message from its snapshot: a stable reference that
// survives ring-buffer eviction, so a narrow selector over this re-renders the
// panel only when the selection changes - not on every flush.
export function selectedMessage(
  session: StreamSession | undefined,
): StreamMessage | undefined {
  if (session?.selectedId == null) return undefined;
  return session.selected ?? undefined;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="truncate font-mono text-xs">{value}</span>
    </div>
  );
}

export function DetailPanel({ streamId }: { streamId: string }) {
  // Narrow subscriptions: re-render only when the selected message (or connId)
  // changes, not on every batch flush that mutates the session's items.
  const msg = useStream((s) => selectedMessage(s.sessions[streamId]));
  const connId = useStream((s) => s.sessions[streamId]?.connId);
  const select = useStream((s) => s.select);
  const [target, setTarget] = useState<DecodeTarget>({
    kind: "builtin",
    format: "json",
  });
  const [targetKey, setTargetKey] = useState<string | null>(null);
  const pinned = useCompare((s) => s.pinned);
  const pin = useCompare((s) => s.pin);
  const clearPin = useCompare((s) => s.clear);

  const subject = msg?.subject ?? null;
  const key = `${connId ?? ""} ${subject ?? ""}`;
  if (key !== targetKey) {
    setTargetKey(key);
    setTarget(
      subject
        ? defaultTarget(connId ?? null, subject)
        : { kind: "builtin", format: "json" },
    );
  }

  const decoded = useDecodedPayload(msg?.payloadB64 ?? null, target);
  const comparePinned = msg && pinned && pinned !== msg ? pinned : null;
  const pinnedDecoded = useDecodedPayload(
    comparePinned?.payloadB64 ?? null,
    target,
  );
  const body = decoded.decoded?.text ?? "";
  const replyTo = msg?.reply ?? null;
  // Reference identity: the same StreamMessage object stays in `items` until
  // evicted, so this is unambiguous across sessions (unlike per-session ids).
  const isPinned = !!(msg && msg === pinned);

  return (
    <aside className="flex h-full w-full flex-col border-l border-border bg-panel">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Message
        </span>
        <div className="flex items-center gap-0.5">
          {msg && connId && (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Republish"
                tooltip="Republish"
                onClick={() =>
                  openPublish(
                    connId,
                    msg.subject,
                    "",
                    msg.headers,
                    msg.payloadB64,
                  )
                }
              >
                <Send />
              </Button>
              {replyTo && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Reply"
                  tooltip={`Reply to ${replyTo}`}
                  onClick={() => openPublish(connId, replyTo, "")}
                >
                  <Reply />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={isPinned ? "Unpin compare base" : "Pin to compare"}
                tooltip={isPinned ? "Unpin compare base" : "Pin to compare"}
                className={cn(isPinned && "text-brand")}
                onClick={() => {
                  if (isPinned) clearPin();
                  else pin(msg);
                }}
              >
                {isPinned ? <PinOff /> : <Pin />}
              </Button>
              <span className="mx-0.5 h-4 w-px bg-border-subtle" />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Copy payload"
                tooltip="Copy payload"
                onClick={() => void navigator.clipboard.writeText(body)}
              >
                <Copy />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Copy as JSON"
                tooltip="Copy message as JSON"
                onClick={() =>
                  void navigator.clipboard.writeText(
                    JSON.stringify(
                      {
                        subject: msg.subject,
                        receivedAt: new Date(msg.receivedAt).toISOString(),
                        reply: msg.reply,
                        headers: msg.headers,
                        payload: body,
                      },
                      null,
                      2,
                    ),
                  )
                }
              >
                <Braces />
              </Button>
              <span className="mx-0.5 h-4 w-px bg-border-subtle" />
            </>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close inspector"
            tooltip="Close inspector"
            onClick={() => select(streamId, null)}
          >
            <X />
          </Button>
        </div>
      </div>

      {!msg ? (
        <EmptyState className="min-h-0 flex-1">
          Select a message to inspect it.
        </EmptyState>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
          <div className="space-y-1.5">
            <Field label="Subject" value={msg.subject} />
            <Field
              label="Received"
              value={`${fmtDateTime(msg.receivedAt)} · ${fmtRelTime(msg.receivedAt)}`}
            />
            <Field label="Size" value={fmtBytes(msg.size)} />
            {msg.reply && <Field label="Reply" value={msg.reply} />}
          </div>

          {msg.headers.length > 0 && (
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Headers
              </p>
              <div className="rounded-md border border-border">
                {msg.headers.map(([k, v], i) => (
                  <div
                    key={i}
                    className="flex justify-between gap-2 border-b border-border/50 px-2 py-1 font-mono text-[11px] last:border-0"
                  >
                    <span className="text-muted-foreground">{k}</span>
                    <span className="truncate">{v}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="mb-1 flex items-center gap-2">
              <PayloadFormatBar
                value={target}
                onChange={setTarget}
                connId={connId}
                subject={msg.subject}
              />
              {comparePinned && (
                <span className="ml-auto flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                  diff vs pinned
                  <button
                    type="button"
                    onClick={() => clearPin()}
                    aria-label="Clear comparison"
                    title="Clear comparison"
                    className="rounded text-muted-foreground hover:text-foreground [&_svg]:size-3"
                  >
                    <X />
                  </button>
                </span>
              )}
            </div>
            {(decoded.error ?? pinnedDecoded.error) ? (
              <p className="text-xs text-error">
                {decoded.error ?? pinnedDecoded.error}
              </p>
            ) : comparePinned ? (
              pinnedDecoded.loading || decoded.loading ? (
                <p className="text-xs text-muted-foreground">Decoding…</p>
              ) : (
                <PayloadDiff a={pinnedDecoded.decoded?.text ?? ""} b={body} />
              )
            ) : (
              <CodeViewer
                value={decoded.loading ? "Decoding…" : body}
                language={decoded.decoded?.language ?? "text"}
                className="min-h-0 flex-1"
              />
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
