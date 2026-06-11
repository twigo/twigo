import { RefreshCw, Loader2, Box } from "lucide-react";
import { Button, EmptyState } from "@twigo/ui";
import { fmtBytes, fmtCount } from "@twigo/utils";
import { useObjectInfo } from "@/hooks/useObjectInfo";
import { Row, Section } from "@/components/editor/jetstream/parts";

export function ObjectDetailPanel({
  connId,
  bucket,
  name,
}: {
  connId: string;
  bucket: string;
  name: string;
}) {
  const { data, error, loading, refresh } = useObjectInfo(connId, bucket, name);
  const meta = data ? Object.entries(data.metadata) : [];

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <Box className="size-3.5 text-brand" />
        <span className="ml-1 truncate font-mono text-[11px] font-medium">
          {bucket} / {name}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh"
          title="Refresh"
          className="ml-auto"
          onClick={refresh}
        >
          <RefreshCw className={loading ? "animate-spin" : ""} />
        </Button>
      </div>

      {error ? (
        <EmptyState icon={Box} variant="error" className="flex-1 gap-3">
          <span className="max-w-72 break-words">{error}</span>
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCw />
            Retry
          </Button>
        </EmptyState>
      ) : !data ? (
        <EmptyState icon={Loader2} className="flex-1 [&>svg]:animate-spin">
          Loading…
        </EmptyState>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3">
          <Section title="Object">
            <Row label="Size" value={fmtBytes(data.size)} />
            <Row label="Chunks" value={fmtCount(data.chunks)} />
            <Row label="Modified" value={data.modified ?? "—"} />
            <Row
              label="Digest"
              value={<span className="truncate">{data.digest ?? "—"}</span>}
            />
            <Row
              label="Deleted"
              value={
                <span className={data.deleted ? "text-warn" : ""}>
                  {data.deleted ? "yes" : "no"}
                </span>
              }
            />
            {data.description && (
              <Row label="Description" value={data.description} />
            )}
          </Section>

          {meta.length > 0 && (
            <Section title="Metadata">
              {meta.map(([k, v]) => (
                <Row key={k} label={k} value={v} />
              ))}
            </Section>
          )}

          {data.headers.length > 0 && (
            <Section title="Headers">
              {data.headers.map(([k, v], i) => (
                <Row key={`${k}:${String(i)}`} label={k} value={v} />
              ))}
            </Section>
          )}
        </div>
      )}
    </div>
  );
}
