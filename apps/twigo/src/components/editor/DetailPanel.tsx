import { useState } from "react";
import { Copy, Braces, Send, Reply, Pin, PinOff, X } from "lucide-react";
import { Button, EmptyState, CodeViewer, cn } from "@twigo/ui";
import {
  fmtDateTime,
  fmtRelTime,
  fmtBytes,
  decodeText,
  tryPrettyJson,
  toHex,
  type StreamMessage,
} from "@twigo/utils";
import { useStream } from "@/store/stream";
import { useCompare } from "@/store/compare";
import { openPublish } from "@/lib/editor";
import { PayloadDiff } from "./PayloadDiff";
import { FormatToggle, type PayloadFormat } from "./FormatToggle";

function bodyFor(m: StreamMessage, format: PayloadFormat): string {
  if (format === "hex") return toHex(m.payloadB64);
  if (format === "text") return decodeText(m.payloadB64);
  return tryPrettyJson(m.payloadB64) ?? decodeText(m.payloadB64);
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
  const session = useStream((s) => s.sessions[streamId]);
  const select = useStream((s) => s.select);
  const [format, setFormat] = useState<PayloadFormat>("json");
  const pinned = useCompare((s) => s.pinned);
  const pin = useCompare((s) => s.pin);
  const clearPin = useCompare((s) => s.clear);

  const selectedId = session?.selectedId ?? null;
  const msg =
    selectedId !== null
      ? session?.items.find((m) => m.id === selectedId)
      : undefined;

  const body = msg ? bodyFor(msg, format) : "";
  const payloadText = msg ? decodeText(msg.payloadB64) : "";
  const replyTo = msg?.reply ?? null;
  // Reference identity: the same StreamMessage object stays in `items` until
  // evicted, so this is unambiguous across sessions (unlike per-session ids).
  const isPinned = !!(msg && msg === pinned);
  // The pinned message to diff against, when viewing a different one.
  const comparePinned = msg && pinned && pinned !== msg ? pinned : null;

  return (
    <aside className="flex h-full w-full flex-col border-l border-border bg-panel">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Message
        </span>
        <div className="flex items-center gap-0.5">
          {msg && session && (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Republish"
                tooltip="Republish"
                onClick={() =>
                  openPublish(
                    session.connId,
                    msg.subject,
                    payloadText,
                    msg.headers,
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
                  onClick={() => openPublish(session.connId, replyTo, "")}
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
                        payload: payloadText,
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
            <div className="mb-1 flex items-center gap-0.5">
              <FormatToggle value={format} onChange={setFormat} />
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
            {comparePinned ? (
              <PayloadDiff a={bodyFor(comparePinned, format)} b={body} />
            ) : (
              <CodeViewer
                value={body}
                language={format === "json" ? "json" : "text"}
                className="min-h-0 flex-1"
              />
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
