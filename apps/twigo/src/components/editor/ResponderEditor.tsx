import { useEffect, useMemo, useState } from "react";
import { Play, Square, Plus, X, Trash2 } from "lucide-react";
import { Button, Input, Label, CodeViewer, cn } from "@twigo/ui";
import { fmtTime } from "@twigo/utils";
import { useConnections } from "@/store/connections";
import {
  useResponder,
  type ResponderMode,
  type ReplyOutcome,
  type ResponderConfig,
} from "@/store/responder";
import { render, buildMsgContext, type RenderResult } from "@/lib/template";
import { makeTemplateCompletion } from "@/lib/template-completion";
import type { IncomingMessage } from "@/lib/api";

const MODES: { key: ResponderMode; label: string; hint: string }[] = [
  { key: "reply", label: "Reply", hint: "Send the rendered template" },
  { key: "error", label: "Error", hint: "Reply with a service-error header" },
  {
    key: "down",
    label: "Down",
    hint: "Don't answer — let the request time out",
  },
];

const SAMPLE: IncomingMessage = {
  subject: "orders.42.get",
  reply: "_INBOX.sample",
  payloadB64: btoa(
    JSON.stringify({ id: 42, name: "sample", items: [1, 2, 3] }),
  ),
  headers: [["X-Trace-Id", "demo"]],
  size: 0,
};

function HeaderRows({
  headers,
  onChange,
}: {
  headers: [string, string][];
  onChange: (next: [string, string][]) => void;
}) {
  const setCell = (i: number, col: 0 | 1, val: string) =>
    onChange(
      headers.map((h, j) =>
        j === i ? (col === 0 ? [val, h[1]] : [h[0], val]) : h,
      ),
    );
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label>Response headers</Label>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange([...headers, ["", ""]])}
        >
          <Plus />
          Add
        </Button>
      </div>
      {headers.map((h, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            value={h[0]}
            onChange={(e) => setCell(i, 0, e.target.value)}
            placeholder="Header"
            spellCheck={false}
            className="font-mono text-xs"
          />
          <Input
            value={h[1]}
            onChange={(e) => setCell(i, 1, e.target.value)}
            placeholder="value"
            spellCheck={false}
            className="font-mono text-xs"
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Remove header"
            onClick={() => onChange(headers.filter((_, j) => j !== i))}
          >
            <X />
          </Button>
        </div>
      ))}
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: ReplyOutcome }) {
  const map = {
    sent: "text-ok",
    error: "text-error",
    skipped: "text-muted-foreground",
  } as const;
  const label =
    outcome.kind === "sent"
      ? "sent"
      : outcome.kind === "error"
        ? "error"
        : "skipped";
  return (
    <span
      className={cn("shrink-0 uppercase tracking-wider", map[outcome.kind])}
    >
      {label}
    </span>
  );
}

export function ResponderEditor({
  id,
  connId,
  initialSubject,
}: {
  id: string;
  connId: string;
  initialSubject: string;
}) {
  useEffect(() => {
    useResponder.getState().ensure(id, connId, initialSubject);
  }, [id, connId, initialSubject]);

  const session = useResponder((s) => s.byConn[connId]?.[id]);
  const live = useConnections(
    (s) =>
      session !== undefined && s.connected[session.connId]?.connected === true,
  );
  const [preview, setPreview] = useState<RenderResult | null>(null);

  const template = session?.config.template ?? "";
  const lastRequest = session?.lastRequest ?? null;
  const previewCtx = useMemo(
    () => buildMsgContext(lastRequest ?? SAMPLE),
    [lastRequest],
  );

  const completion = useMemo(
    () =>
      makeTemplateCompletion(() => {
        const last =
          useResponder.getState().byConn[connId]?.[id]?.lastRequest ?? null;
        const c = buildMsgContext(last ?? SAMPLE);
        return { $msg: c, $json: c.body };
      }),
    [id, connId],
  );

  useEffect(() => {
    let alive = true;
    void render(template, previewCtx).then((r) => {
      if (alive) setPreview(r);
    });
    return () => {
      alive = false;
    };
  }, [template, previewCtx]);

  if (!session) return null;
  const { config, listening, handled, log } = session;
  const subject = config.subject;
  const set = (p: Partial<ResponderConfig>) =>
    useResponder.getState().setConfig(connId, id, p);
  const canStart = live && subject.trim().length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto bg-background p-3">
      {!live && (
        <p className="text-xs text-warn">
          Not connected — connect{" "}
          <span className="font-mono">{session.connId}</span> to respond.
        </p>
      )}

      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="resp-subject">Listen on subject</Label>
          <Input
            id="resp-subject"
            value={subject}
            onChange={(e) => set({ subject: e.target.value })}
            placeholder="orders.*.get"
            spellCheck={false}
            disabled={listening}
            className="font-mono text-xs"
          />
        </div>
        {listening ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void useResponder.getState().stop(connId, id)}
          >
            <Square />
            Stop
          </Button>
        ) : (
          <Button
            variant="brand"
            size="sm"
            disabled={!canStart}
            onClick={() => void useResponder.getState().start(connId, id)}
          >
            <Play />
            Start
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-md border border-border p-0.5">
          {MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              title={m.hint}
              onClick={() => set({ mode: m.key })}
              className={cn(
                "rounded px-2 py-1 text-xs transition-colors",
                config.mode === m.key
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <Label htmlFor="resp-delay" className="text-muted-foreground">
            Delay
          </Label>
          <Input
            id="resp-delay"
            type="number"
            min={0}
            value={config.delayMs}
            onChange={(e) =>
              set({ delayMs: Math.max(0, Number(e.target.value) || 0) })
            }
            className="h-7 w-20 text-xs"
          />
          <span className="text-xs text-muted-foreground">ms</span>
        </div>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className={cn(
              "size-2 rounded-full",
              listening ? "animate-pulse bg-ok" : "bg-muted-foreground/40",
            )}
          />
          {listening ? "listening" : "stopped"} · {handled} handled
        </span>
      </div>

      <HeaderRows
        headers={config.headers}
        onChange={(headers) => set({ headers })}
      />

      <div className="flex min-h-32 flex-1 flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <Label>Response template</Label>
          <span className="text-[11px] text-muted-foreground">
            {"{{ $msg.body.field }}"} · $json · $uuid() · $now
          </span>
        </div>
        <CodeViewer
          value={template}
          language="json"
          onChange={(v) => set({ template: v })}
          completion={completion}
          className="min-h-0 flex-1"
        />
      </div>

      <div className="flex min-h-24 shrink-0 flex-col gap-1.5">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="uppercase tracking-wider">Preview</span>
          <span className="font-mono">
            against {lastRequest ? "last request" : "sample"}
          </span>
          {preview && !preview.ok && (
            <span className="ml-auto text-error">expression error</span>
          )}
        </div>
        <CodeViewer
          value={
            preview === null ? "" : preview.ok ? preview.output : preview.error
          }
          language={preview?.ok ? "json" : "text"}
          className="h-32"
        />
      </div>

      {log.length > 0 && (
        <div className="shrink-0 space-y-1.5">
          <div className="flex items-center justify-between">
            <Label>Requests</Label>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => useResponder.getState().clearLog(connId, id)}
            >
              <Trash2 />
              Clear
            </Button>
          </div>
          <div className="overflow-hidden rounded-md border border-border">
            {log.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center gap-2 border-b border-border px-2 py-1 text-[11px] last:border-b-0"
              >
                <span className="tabular-nums text-muted-foreground">
                  {fmtTime(entry.receivedAt)}
                </span>
                <span className="truncate font-mono">
                  {entry.requestSubject}
                </span>
                <span className="ml-auto tabular-nums text-muted-foreground">
                  {entry.ms} ms
                </span>
                <OutcomeBadge outcome={entry.outcome} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
