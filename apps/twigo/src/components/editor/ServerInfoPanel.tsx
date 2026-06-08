import { RefreshCw, Loader2, Server, Check, Minus } from "lucide-react";
import { Button, EmptyState } from "@twigo/ui";
import { fmtBytes, fmtRtt } from "@twigo/utils";
import { useServerInfo } from "@/hooks/useServerInfo";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="shrink-0 text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 truncate text-right font-mono text-xs">
        {value}
      </span>
    </div>
  );
}

function Bool({ value }: { value: boolean }) {
  return value ? (
    <span className="inline-flex items-center gap-1 text-ok">
      <Check className="size-3.5" /> yes
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <Minus className="size-3.5" /> no
    </span>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      <div className="rounded-md border border-border px-3 py-1">
        {children}
      </div>
    </section>
  );
}

export function ServerInfoPanel({ connId }: { connId: string }) {
  const { data, error, loading, refresh } = useServerInfo(connId);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <Server className="size-3.5 text-brand" />
        <span className="ml-1 truncate text-[11px] font-medium">{connId}</span>
        {data && (
          <span className="ml-1 text-[11px] tabular-nums text-muted-foreground">
            RTT {fmtRtt(data.rttMs)}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label="Refresh"
          title="Refresh"
          onClick={refresh}
        >
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </Button>
      </div>

      {error ? (
        <EmptyState variant="error" className="min-h-0 flex-1">
          {error}
        </EmptyState>
      ) : !data ? (
        <EmptyState className="min-h-0 flex-1">Loading server info…</EmptyState>
      ) : (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
          <Section title="Identity">
            <Row label="Server name" value={data.serverName} />
            <Row label="Server ID" value={data.serverId} />
            <Row label="Version" value={data.version} />
            <Row label="Go" value={data.go} />
          </Section>

          <Section title="Network">
            <Row label="Host" value={`${data.host}:${data.port.toString()}`} />
            <Row label="Client ID" value={data.clientId} />
            <Row label="Client IP" value={data.clientIp || "—"} />
            <Row label="Protocol" value={data.proto} />
          </Section>

          <Section title="Capabilities">
            <Row label="Max payload" value={fmtBytes(data.maxPayload)} />
            <Row label="JetStream" value={<Bool value={data.jetstream} />} />
            <Row label="Headers" value={<Bool value={data.headers} />} />
            <Row
              label="TLS required"
              value={<Bool value={data.tlsRequired} />}
            />
            <Row
              label="Auth required"
              value={<Bool value={data.authRequired} />}
            />
            <Row
              label="Lame duck mode"
              value={<Bool value={data.lameDuckMode} />}
            />
          </Section>

          {(data.cluster ?? data.domain ?? data.connectUrls.length > 0) && (
            <Section title="Cluster">
              {data.cluster && <Row label="Cluster" value={data.cluster} />}
              {data.domain && <Row label="Domain" value={data.domain} />}
              {data.connectUrls.length > 0 && (
                <Row label="Connect URLs" value={data.connectUrls.join(", ")} />
              )}
            </Section>
          )}
        </div>
      )}
    </div>
  );
}
