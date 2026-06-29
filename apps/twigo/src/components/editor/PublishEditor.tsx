import { useState, useEffect, useRef } from "react";
import { Send, Loader2, ArrowLeftRight, Plus, X } from "lucide-react";
import { Button, Input, Label, CodeViewer } from "@twigo/ui";
import { decodeText, tryPrettyJson, fmtBytes } from "@twigo/utils";
import { useConnections } from "@/store/connections";
import { useIsReadOnly } from "@/hooks/useIsReadOnly";
import { publish, request, type IncomingMessage } from "@/lib/api";

type Reply =
  | { kind: "msg"; msg: IncomingMessage; ms: number }
  | { kind: "error"; error: string };

function isJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

export function PublishEditor({
  connId,
  initialSubject,
  initialPayload = "",
  initialHeaders,
}: {
  connId: string;
  initialSubject: string;
  initialPayload?: string;
  initialHeaders?: [string, string][];
}) {
  const live = useConnections((s) => s.connected[connId]?.connected === true);
  const readOnly = useIsReadOnly(connId);
  const [subject, setSubject] = useState(initialSubject);
  const [payload, setPayload] = useState(initialPayload);
  const [headers, setHeaders] = useState<[string, string][]>(
    initialHeaders ?? [],
  );
  const [busy, setBusy] = useState<"publish" | "request" | null>(null);
  const [reply, setReply] = useState<Reply | null>(null);
  const [sent, setSent] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    },
    [],
  );

  const canSend =
    live && !readOnly && subject.trim().length > 0 && busy === null;
  const invalidJson = payload.trim() !== "" && !isJson(payload);
  const cleanHeaders = (): [string, string][] =>
    headers.filter(([k]) => k.trim() !== "");

  function setHeader(i: number, col: 0 | 1, val: string) {
    setHeaders((hs) =>
      hs.map((h, j) => (j === i ? (col === 0 ? [val, h[1]] : [h[0], val]) : h)),
    );
  }

  async function doPublish() {
    setBusy("publish");
    setReply(null);
    setSent(false);
    try {
      await publish(connId, subject.trim(), payload, cleanHeaders());
      setSent(true);
      // Reset the flash window on overlapping sends; the unmount effect clears
      // a pending timer so we never setState after the editor closes.
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => {
        flashTimer.current = null;
        setSent(false);
      }, 1500);
    } catch (e) {
      setReply({ kind: "error", error: String(e) });
    } finally {
      setBusy(null);
    }
  }

  async function doRequest() {
    setBusy("request");
    setReply(null);
    setSent(false);
    const t0 = performance.now();
    try {
      const msg = await request(
        connId,
        subject.trim(),
        payload,
        null,
        cleanHeaders(),
      );
      setReply({ kind: "msg", msg, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      setReply({ kind: "error", error: String(e) });
    } finally {
      setBusy(null);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canSend) {
      e.preventDefault();
      if (e.shiftKey) void doRequest();
      else void doPublish();
    }
  }

  const replyBody =
    reply?.kind === "msg"
      ? (tryPrettyJson(reply.msg.payloadB64) ??
        decodeText(reply.msg.payloadB64))
      : "";
  const replyLang =
    reply?.kind === "msg" && tryPrettyJson(reply.msg.payloadB64) !== null
      ? "json"
      : "text";

  return (
    <div
      onKeyDown={onKeyDown}
      className="flex h-full min-h-0 flex-col gap-3 bg-background p-3"
    >
      {!live && (
        <p className="text-xs text-warn">
          Not connected - connect <span className="font-mono">{connId}</span> to
          publish.
        </p>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="pub-subject">Subject</Label>
        <Input
          id="pub-subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="orders.created"
          spellCheck={false}
          className="font-mono text-xs"
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label>Headers</Label>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setHeaders((hs) => [...hs, ["", ""]])}
          >
            <Plus />
            Add
          </Button>
        </div>
        {headers.map((h, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input
              value={h[0]}
              onChange={(e) => setHeader(i, 0, e.target.value)}
              placeholder="Header"
              spellCheck={false}
              className="font-mono text-xs"
            />
            <Input
              value={h[1]}
              onChange={(e) => setHeader(i, 1, e.target.value)}
              placeholder="value"
              spellCheck={false}
              className="font-mono text-xs"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Remove header"
              onClick={() => setHeaders((hs) => hs.filter((_, j) => j !== i))}
            >
              <X />
            </Button>
          </div>
        ))}
      </div>

      <div className="flex min-h-24 flex-1 flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <Label>Payload</Label>
          <div className="flex items-center gap-2">
            {invalidJson && (
              <span className="text-[11px] text-warn">invalid JSON</span>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={invalidJson || payload.trim() === ""}
              onClick={() =>
                setPayload(JSON.stringify(JSON.parse(payload), null, 2))
              }
            >
              Format
            </Button>
          </div>
        </div>
        <CodeViewer
          value={payload}
          language="json"
          onChange={setPayload}
          className="min-h-0 flex-1"
        />
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="brand"
          size="sm"
          disabled={!canSend}
          title={readOnly ? "Connection is read-only" : undefined}
          onClick={() => void doPublish()}
        >
          {busy === "publish" ? <Loader2 className="animate-spin" /> : <Send />}
          Publish
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!canSend}
          title={readOnly ? "Connection is read-only" : undefined}
          onClick={() => void doRequest()}
        >
          {busy === "request" ? (
            <Loader2 className="animate-spin" />
          ) : (
            <ArrowLeftRight />
          )}
          Request
        </Button>
        <span className="text-[11px] text-muted-foreground">
          ⌘↵ publish · ⇧⌘↵ request
        </span>
        {sent && <span className="ml-auto text-xs text-ok">Published</span>}
      </div>

      {reply?.kind === "error" && (
        <p className="text-xs text-error">{reply.error}</p>
      )}

      {reply?.kind === "msg" && (
        <div className="flex min-h-24 flex-1 flex-col gap-1.5">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="uppercase tracking-wider">Reply</span>
            <span className="truncate font-mono">{reply.msg.subject}</span>
            <span className="ml-auto tabular-nums">
              {reply.ms} ms · {fmtBytes(reply.msg.size)}
            </span>
          </div>
          <CodeViewer
            value={replyBody}
            language={replyLang}
            className="min-h-0 flex-1"
          />
        </div>
      )}
    </div>
  );
}
