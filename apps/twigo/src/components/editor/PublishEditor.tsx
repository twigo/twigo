import { useState, useEffect, useRef } from "react";
import { Send, Loader2, ArrowLeftRight, Plus, X, FileUp } from "lucide-react";
import {
  Button,
  Input,
  Label,
  CodeViewer,
  cn,
  Select as SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@twigo/ui";
import { decodeText, tryPrettyJson, fmtBytes } from "@twigo/utils";
import {
  useConnections,
  selectIsLive,
  selectMaxPayload,
} from "@/store/connections";
import { useHistory } from "@/store/history";
import { useCodecs } from "@/store/codecs";
import { useIsReadOnly } from "@/hooks/useIsReadOnly";
import { encodePayload } from "@/lib/codecs";
import {
  publish,
  request,
  pickPayloadFile,
  reachedTheWire,
  type IncomingMessage,
  type PickedPayload,
} from "@/lib/api";
import {
  PAYLOAD_MODES,
  isBase64,
  isCodecMode,
  wirePayload,
  type PayloadMode,
} from "./publishPayload";

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
  initialPayloadB64 = "",
  initialHeaders,
}: {
  connId: string;
  initialSubject: string;
  initialPayload?: string;
  initialPayloadB64?: string;
  initialHeaders?: [string, string][];
}) {
  const live = useConnections(selectIsLive(connId));
  const maxPayload = useConnections(selectMaxPayload(connId, 1024 * 1024));
  const readOnly = useIsReadOnly(connId);
  const [subject, setSubject] = useState(initialSubject);
  const [mode, setMode] = useState<PayloadMode>(
    initialPayloadB64 ? "binary" : "json",
  );
  const [payload, setPayload] = useState(
    initialPayloadB64 ? initialPayloadB64 : initialPayload,
  );
  const [file, setFile] = useState<PickedPayload | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const schemas = useCodecs((s) => s.schemas);
  const [schemaId, setSchemaId] = useState<string | undefined>(schemas[0]?.id);
  const [messageType, setMessageType] = useState<string | undefined>(
    schemas[0]?.messageTypes[0],
  );
  const protoSchema = useCodecs.getState().schemaById(schemaId);
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

  const codec = isCodecMode(mode) ? mode : null;
  const jsonMode = mode === "json" || codec !== null;
  const wire = codec ? "" : wirePayload(mode, payload, file);
  const invalidJson = jsonMode && payload.trim() !== "" && !isJson(payload);
  const invalidBase64 =
    mode === "binary" && payload.trim() !== "" && !isBase64(payload);
  const protoReady = mode !== "protobuf" || (!!schemaId && !!messageType);
  const payloadValid = codec
    ? payload.trim() !== "" && !invalidJson && protoReady
    : wire !== null;
  const canSend =
    live &&
    !readOnly &&
    subject.trim().length > 0 &&
    busy === null &&
    payloadValid;
  const cleanHeaders = (): [string, string][] =>
    headers.filter(([k]) => k.trim() !== "");

  async function resolveWire(): Promise<string> {
    if (codec) {
      return encodePayload(payload, {
        kind: "codec",
        codec,
        schemaId,
        messageType,
      });
    }
    const w = wirePayload(mode, payload, file);
    if (w === null) throw new Error("payload is not ready");
    return w;
  }

  function setHeader(i: number, col: 0 | 1, val: string) {
    setHeaders((hs) =>
      hs.map((h, j) => (j === i ? (col === 0 ? [val, h[1]] : [h[0], val]) : h)),
    );
  }

  function recordSend(kind: "publish" | "request", payloadB64: string) {
    useHistory.getState().record({
      connId,
      kind,
      subject: subject.trim(),
      payloadB64,
      headers: cleanHeaders(),
    });
  }

  async function doPublish() {
    setBusy("publish");
    setReply(null);
    setSent(false);
    try {
      const w = await resolveWire();
      try {
        await publish(connId, subject.trim(), w, cleanHeaders());
      } catch (e) {
        if (reachedTheWire(e)) recordSend("publish", w);
        throw e;
      }
      recordSend("publish", w);
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
      const w = await resolveWire();
      let msg;
      try {
        msg = await request(connId, subject.trim(), w, null, cleanHeaders());
      } catch (e) {
        if (reachedTheWire(e)) recordSend("request", w);
        throw e;
      }
      recordSend("request", w);
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
          <div className="flex items-center gap-2">
            <Label>Payload</Label>
            <div className="flex rounded-md border border-border p-0.5">
              {PAYLOAD_MODES.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => {
                    setMode(m.key);
                    setPickError(null);
                  }}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[11px]",
                    mode === m.key
                      ? "bg-accent font-medium"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {invalidJson && (
              <span className="text-[11px] text-warn">invalid JSON</span>
            )}
            {invalidBase64 && (
              <span className="text-[11px] text-warn">invalid base64</span>
            )}
            {jsonMode && (
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
            )}
          </div>
        </div>

        {mode === "protobuf" && (
          <div className="flex items-center gap-1.5">
            <SelectRoot
              value={schemaId ?? ""}
              onValueChange={(id) => {
                setSchemaId(id);
                setMessageType(
                  useCodecs.getState().schemaById(id)?.messageTypes[0],
                );
              }}
            >
              <SelectTrigger className="h-6 w-32 text-[11px]">
                <SelectValue placeholder="schema" />
              </SelectTrigger>
              <SelectContent>
                {schemas.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </SelectRoot>
            <SelectRoot
              value={messageType ?? ""}
              onValueChange={setMessageType}
            >
              <SelectTrigger className="h-6 w-48 text-[11px]">
                <SelectValue placeholder="message type" />
              </SelectTrigger>
              <SelectContent>
                {(protoSchema?.messageTypes ?? []).map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </SelectRoot>
            {schemas.length === 0 && (
              <span className="text-[11px] text-warn">
                Import a .proto schema in Settings → Schemas.
              </span>
            )}
          </div>
        )}
        {mode === "file" ? (
          <div className="flex min-h-0 flex-1 flex-col items-start gap-2 rounded-md border border-dashed border-border p-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setPickError(null);
                pickPayloadFile(maxPayload)
                  .then((p) => {
                    if (p) setFile(p);
                  })
                  .catch((e: unknown) => {
                    setPickError(String(e));
                  });
              }}
            >
              <FileUp />
              Choose file…
            </Button>
            {file && (
              <span className="flex items-center gap-1.5 text-xs">
                <span className="font-mono">{file.name}</span>
                <span className="text-muted-foreground">
                  {fmtBytes(file.size)}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Clear file"
                  onClick={() => setFile(null)}
                >
                  <X />
                </Button>
              </span>
            )}
            {pickError && <p className="text-xs text-error">{pickError}</p>}
            <p className="text-[11px] text-muted-foreground">
              Sent as raw bytes · limit {fmtBytes(maxPayload)}.
            </p>
          </div>
        ) : (
          <CodeViewer
            value={payload}
            language={jsonMode ? "json" : "text"}
            onChange={setPayload}
            className="min-h-0 flex-1"
          />
        )}
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
