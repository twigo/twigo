import { useState } from "react";
import { ChevronRight, RefreshCw, Send, Loader2, Trash2 } from "lucide-react";
import { Button, CodeViewer, cn } from "@twigo/ui";
import {
  fmtBytes,
  decodeText,
  decodePreview,
  tryPrettyJson,
  toHex,
} from "@twigo/utils";
import { jsGetMessages, jsDeleteMessage, type StoredMessage } from "@/lib/api";
import { openPublish } from "@/lib/editor";
import { useJetStream } from "@/store/jetstream";
import { useToasts } from "@/store/toasts";
import { ConfirmDialog } from "./ConfirmDialog";

type Format = "json" | "text" | "hex";
const FORMATS: Format[] = ["json", "text", "hex"];
const PAGE = 25;

// Non-destructive message browse (direct-get only — never creates a consumer,
// never advances an ack floor). Walks newest → older.
export function MessageBrowser({
  connId,
  stream,
}: {
  connId: string;
  stream: string;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [nextSeq, setNextSeq] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [format, setFormat] = useState<Format>("json");
  const [seqInput, setSeqInput] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);

  const load = async (start: number | null, append: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const page = await jsGetMessages(connId, stream, start, PAGE, true);
      setMessages((prev) =>
        append ? [...prev, ...page.messages] : page.messages,
      );
      setNextSeq(page.nextSeq);
      if (!append) setSelectedSeq(page.messages[0]?.seq ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && messages.length === 0) void load(null, false);
  };

  const loadFromSeq = () => {
    const n = Number(seqInput);
    if (Number.isFinite(n) && n > 0) void load(Math.floor(n), false);
  };

  const doDelete = async (seq: number) => {
    try {
      await jsDeleteMessage(connId, stream, seq);
      const idx = messages.findIndex((m) => m.seq === seq);
      const next = messages.filter((m) => m.seq !== seq);
      setMessages(next);
      // Keep a selection: the row that took the deleted slot, else the previous.
      setSelectedSeq(next[idx]?.seq ?? next[idx - 1]?.seq ?? null);
      useToasts.getState().push("success", `Deleted message #${String(seq)}`);
      void useJetStream.getState().load(connId);
    } catch (e) {
      useToasts.getState().push("error", `Delete failed: ${String(e)}`);
    }
  };

  const selected = messages.find((m) => m.seq === selectedSeq);
  const body = selected
    ? format === "hex"
      ? toHex(selected.payloadB64)
      : format === "text"
        ? decodeText(selected.payloadB64)
        : (tryPrettyJson(selected.payloadB64) ??
          decodeText(selected.payloadB64))
    : "";

  return (
    <section>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          <ChevronRight
            className={cn("size-3 transition-transform", open && "rotate-90")}
          />
          Messages
        </button>
        {open && (
          <div className="ml-auto flex items-center gap-1">
            <input
              value={seqInput}
              onChange={(e) => setSeqInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") loadFromSeq();
              }}
              inputMode="numeric"
              placeholder="seq…"
              aria-label="Browse from sequence"
              className="h-6 w-16 rounded border border-border bg-background px-1.5 font-mono text-xs"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Load latest"
              title="Load latest"
              onClick={() => void load(null, false)}
            >
              <RefreshCw className={loading ? "animate-spin" : ""} />
            </Button>
          </div>
        )}
      </div>

      {open && (
        <div className="mt-1 flex flex-col gap-2">
          {error ? (
            <p className="px-1 text-xs text-error">{error}</p>
          ) : messages.length === 0 && !loading ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">
              No messages — use the seq field to jump to a sequence.
            </p>
          ) : (
            <>
              <ul className="max-h-56 overflow-auto rounded-md border border-border">
                {messages.map((m) => (
                  <li key={m.seq}>
                    <button
                      type="button"
                      onClick={() => setSelectedSeq(m.seq)}
                      className={cn(
                        "flex w-full items-center gap-2 border-b border-border/50 px-2 py-1 text-left font-mono text-[11px] last:border-0 hover:bg-row-hover",
                        m.seq === selectedSeq && "bg-selected",
                      )}
                    >
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        #{m.seq}
                      </span>
                      <span className="shrink-0 text-brand">{m.subject}</span>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {decodePreview(m.payloadB64)}
                      </span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {fmtBytes(m.size)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>

              {nextSeq !== null ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loading}
                  onClick={() => void load(nextSeq, true)}
                >
                  {loading && <Loader2 className="animate-spin" />}
                  Load older
                </Button>
              ) : (
                <p className="py-1 text-center text-[10px] uppercase tracking-wider text-muted-foreground">
                  — start of stream —
                </p>
              )}

              {selected && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      #{selected.seq} · {selected.subject}
                      {selected.time ? ` · ${selected.time}` : ""}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="ml-auto"
                      aria-label="Republish"
                      title="Republish to a new publish tab"
                      onClick={() =>
                        openPublish(
                          connId,
                          selected.subject,
                          decodeText(selected.payloadB64),
                          selected.headers,
                        )
                      }
                    >
                      <Send />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Delete message"
                      title="Delete message"
                      className="text-error"
                      onClick={() => setDeleteOpen(true)}
                    >
                      <Trash2 />
                    </Button>
                  </div>

                  {selected.headers.length > 0 && (
                    <div className="rounded-md border border-border">
                      {selected.headers.map(([k, v], i) => (
                        <div
                          key={i}
                          className="flex justify-between gap-2 border-b border-border/50 px-2 py-0.5 font-mono text-[11px] last:border-0"
                        >
                          <span className="text-muted-foreground">{k}</span>
                          <span className="truncate">{v}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center gap-0.5">
                    {FORMATS.map((f) => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => setFormat(f)}
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider",
                          format === f
                            ? "bg-accent text-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                  {selected.truncated && (
                    <p className="text-[10px] text-warn">
                      Payload truncated to 1 MB for display ·{" "}
                      {fmtBytes(selected.size)} total.
                    </p>
                  )}
                  <CodeViewer
                    value={body}
                    language={format === "json" ? "json" : "text"}
                    className="max-h-64"
                  />

                  <ConfirmDialog
                    open={deleteOpen}
                    onOpenChange={setDeleteOpen}
                    title={`Delete message #${String(selected.seq)}?`}
                    description="This permanently removes the message from the stream. This can't be undone."
                    confirmLabel="Delete message"
                    onConfirm={() => void doDelete(selected.seq)}
                  />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
