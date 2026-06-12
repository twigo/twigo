import { useState } from "react";
import { Copy, Send, Reply } from "lucide-react";
import { Button, EmptyState, CodeViewer, cn } from "@twigo/ui";
import {
  fmtDateTime,
  fmtRelTime,
  fmtBytes,
  decodeText,
  tryPrettyJson,
  toHex,
} from "@twigo/utils";
import { useStream } from "@/store/stream";
import { openPublish } from "@/lib/editor";

type Format = "json" | "text" | "hex";
const FORMATS: Format[] = ["json", "text", "hex"];

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

export function DetailPanel() {
  const session = useStream((s) =>
    s.activeId ? s.sessions[s.activeId] : undefined,
  );
  const [format, setFormat] = useState<Format>("json");

  const selectedId = session?.selectedId ?? null;
  const msg =
    selectedId !== null
      ? session?.items.find((m) => m.id === selectedId)
      : undefined;

  const body = msg
    ? format === "hex"
      ? toHex(msg.payloadB64)
      : format === "text"
        ? decodeText(msg.payloadB64)
        : (tryPrettyJson(msg.payloadB64) ?? decodeText(msg.payloadB64))
    : "";

  const payloadText = msg ? decodeText(msg.payloadB64) : "";
  const replyTo = msg?.reply ?? null;

  return (
    <aside className="flex h-full w-full flex-col border-l border-border bg-panel">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Message
        </span>
        {msg && session && (
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Republish"
              title="Republish"
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
                title={`Reply to ${replyTo}`}
                onClick={() => openPublish(session.connId, replyTo, "")}
              >
                <Reply />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Copy payload"
              title="Copy payload"
              onClick={() => void navigator.clipboard.writeText(body)}
            >
              <Copy />
            </Button>
          </div>
        )}
      </div>

      {!msg ? (
        <EmptyState className="min-h-0 flex-1">
          Select a message to inspect it.
        </EmptyState>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
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
              {FORMATS.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFormat(f)}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    format === f
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {f}
                </button>
              ))}
            </div>
            <CodeViewer
              value={body}
              language={format === "json" ? "json" : "text"}
              className="min-h-0 flex-1"
            />
          </div>
        </div>
      )}
    </aside>
  );
}
