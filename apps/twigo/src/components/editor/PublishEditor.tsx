import { useState } from "react";
import { Send, Loader2, ArrowLeftRight } from "lucide-react";
import { Button, Input, Label, CodeViewer } from "@twigo/ui";
import { decodeText, tryPrettyJson, fmtBytes } from "@twigo/utils";
import { useConnections } from "@/store/connections";
import { publish, request, type IncomingMessage } from "@/lib/api";

type Reply =
  | { kind: "msg"; msg: IncomingMessage }
  | { kind: "error"; error: string };

export function PublishEditor({
  connId,
  initialSubject,
}: {
  connId: string;
  initialSubject: string;
}) {
  const live = useConnections((s) => s.connected[connId]?.connected === true);
  const [subject, setSubject] = useState(initialSubject);
  const [payload, setPayload] = useState("");
  const [busy, setBusy] = useState<"publish" | "request" | null>(null);
  const [reply, setReply] = useState<Reply | null>(null);
  const [sent, setSent] = useState(false);

  const canSend = live && subject.trim().length > 0 && busy === null;

  async function doPublish() {
    setBusy("publish");
    setReply(null);
    setSent(false);
    try {
      await publish(connId, subject.trim(), payload);
      setSent(true);
      setTimeout(() => setSent(false), 1500);
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
    try {
      const msg = await request(connId, subject.trim(), payload);
      setReply({ kind: "msg", msg });
    } catch (e) {
      setReply({ kind: "error", error: String(e) });
    } finally {
      setBusy(null);
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
    <div className="flex h-full min-h-0 flex-col gap-3 bg-background p-3">
      {!live && (
        <p className="text-xs text-warn">
          Not connected — connect <span className="font-mono">{connId}</span> to
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

      <div className="flex min-h-24 flex-1 flex-col gap-1.5">
        <Label htmlFor="pub-payload">Payload</Label>
        <textarea
          id="pub-payload"
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          spellCheck={false}
          placeholder={'{ "hello": "world" }'}
          className="min-h-0 flex-1 resize-none rounded-md border border-input bg-background p-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="brand"
          size="sm"
          disabled={!canSend}
          onClick={() => void doPublish()}
        >
          {busy === "publish" ? <Loader2 className="animate-spin" /> : <Send />}
          Publish
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!canSend}
          onClick={() => void doRequest()}
        >
          {busy === "request" ? (
            <Loader2 className="animate-spin" />
          ) : (
            <ArrowLeftRight />
          )}
          Request
        </Button>
        {sent && <span className="text-xs text-ok">Published</span>}
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
              {fmtBytes(reply.msg.size)}
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
