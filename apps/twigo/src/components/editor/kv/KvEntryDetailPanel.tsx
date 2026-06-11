import { useState } from "react";
import { RefreshCw, Loader2, Database, History } from "lucide-react";
import { Button, EmptyState, CodeViewer, cn } from "@twigo/ui";
import {
  fmtBytes,
  fmtDuration,
  decodeText,
  tryPrettyJson,
  toHex,
} from "@twigo/utils";
import { useKvEntry, useKvBucketInfo, useKvHistory } from "@/hooks/useKvDetail";
import { Row, Section } from "@/components/editor/jetstream/parts";

type Format = "json" | "text" | "hex";
const FORMATS: Format[] = ["json", "text", "hex"];

export function KvEntryDetailPanel({
  connId,
  bucket,
  kvkey,
}: {
  connId: string;
  bucket: string;
  kvkey: string;
}) {
  const [revision, setRevision] = useState<number | null>(null);
  const [format, setFormat] = useState<Format>("json");
  const [histKey, setHistKey] = useState(0);

  const { data, error, loading, refresh } = useKvEntry(
    connId,
    bucket,
    kvkey,
    revision,
  );
  const info = useKvBucketInfo(connId, bucket);
  const history = useKvHistory(connId, bucket, kvkey, histKey);

  const doRefresh = () => {
    setRevision(null);
    setHistKey((k) => k + 1);
    refresh();
  };

  const body = data
    ? format === "hex"
      ? toHex(data.payloadB64)
      : format === "text"
        ? decodeText(data.payloadB64)
        : (tryPrettyJson(data.payloadB64) ?? decodeText(data.payloadB64))
    : "";

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <Database className="size-3.5 text-brand" />
        <span className="ml-1 truncate font-mono text-[11px] font-medium">
          {bucket} / {kvkey}
        </span>
        {revision !== null && (
          <span className="ml-1 text-[11px] text-warn">
            · r{revision} (read-only)
          </span>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh"
          title="Refresh"
          className="ml-auto"
          onClick={doRefresh}
        >
          <RefreshCw className={loading ? "animate-spin" : ""} />
        </Button>
      </div>

      {error ? (
        <EmptyState icon={Database} variant="error" className="flex-1 gap-3">
          <span className="max-w-72 break-words">{error}</span>
          <Button variant="outline" size="sm" onClick={doRefresh}>
            <RefreshCw />
            Retry
          </Button>
        </EmptyState>
      ) : !data ? (
        loading ? (
          <EmptyState icon={Loader2} className="flex-1 [&>svg]:animate-spin">
            Loading…
          </EmptyState>
        ) : (
          <EmptyState icon={Database} className="flex-1">
            Key not found.
          </EmptyState>
        )
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-0.5">
              {FORMATS.map((fmt) => (
                <button
                  key={fmt}
                  type="button"
                  onClick={() => setFormat(fmt)}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider",
                    format === fmt
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {fmt}
                </button>
              ))}
            </div>
            {data.truncated && (
              <p className="text-[10px] text-warn">
                Value truncated to 1 MB for display · {fmtBytes(data.size)}{" "}
                total.
              </p>
            )}
            <CodeViewer
              value={body}
              language={format === "json" ? "json" : "text"}
              className="max-h-72"
            />
          </div>

          <Section title="Entry">
            <Row label="Revision" value={data.revision} />
            <Row label="Created" value={data.created ?? "—"} />
            <Row
              label="Operation"
              value={
                <span className={data.operation !== "put" ? "text-warn" : ""}>
                  {data.operation}
                </span>
              }
            />
            <Row label="Size" value={fmtBytes(data.size)} />
          </Section>

          {info && (
            <Section title="Bucket">
              <Row label="History depth" value={info.history} />
              <Row label="TTL" value={fmtDuration(info.maxAge)} />
              <Row
                label="Max value size"
                value={
                  info.maxValueSize < 0 ? "∞" : fmtBytes(info.maxValueSize)
                }
              />
              <Row label="Storage" value={info.storage} />
              <Row label="Replicas" value={info.replicas} />
            </Section>
          )}

          <section>
            <h3 className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <History className="size-3" />
              History
              {revision !== null && (
                <button
                  type="button"
                  onClick={() => setRevision(null)}
                  className="ml-auto text-brand hover:underline"
                >
                  back to latest
                </button>
              )}
            </h3>
            <ul className="max-h-48 overflow-auto rounded-md border border-border">
              {history.length === 0 ? (
                <li className="px-2 py-1 text-[11px] text-muted-foreground">
                  No history.
                </li>
              ) : (
                history.map((h) => (
                  <li key={h.revision}>
                    <button
                      type="button"
                      onClick={() => setRevision(h.revision)}
                      className={cn(
                        "flex w-full items-center gap-2 border-b border-border/50 px-2 py-1 text-left font-mono text-[11px] last:border-0 hover:bg-accent/50",
                        (revision ?? data.revision) === h.revision &&
                          "bg-accent",
                      )}
                    >
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        r{h.revision}
                      </span>
                      <span
                        className={cn(
                          "shrink-0",
                          h.operation !== "put"
                            ? "text-warn"
                            : "text-muted-foreground",
                        )}
                      >
                        {h.operation}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">
                        {h.created ?? ""}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}
