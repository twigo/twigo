import { useEffect } from "react";
import { RefreshCw, ChevronsDownUp, Loader2, Database } from "lucide-react";
import { Button, EmptyState } from "@twigo/ui";
import { useConnections } from "@/store/connections";
import { useKv } from "@/store/kv";
import type { ViewProps } from "@/components/views/registry";
import { KvTree } from "./KvTree";

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}

export function KvView({ filter, connId }: ViewProps) {
  const isConnected = useConnections((s) => !!(connId && s.connected[connId]));
  const jsEnabled = useConnections((s) =>
    connId ? (s.connected[connId]?.jetstream ?? false) : false,
  );
  const data = useKv((s) => (connId ? s.byConn[connId] : undefined));
  const load = useKv((s) => s.load);
  const collapseAll = useKv((s) => s.collapseAll);

  useEffect(() => {
    if (
      connId &&
      isConnected &&
      jsEnabled &&
      (data?.status ?? "idle") === "idle"
    ) {
      void load(connId);
    }
  }, [connId, isConnected, jsEnabled, data?.status, load]);

  if (!isConnected || !connId) {
    return <Hint>Connect to a server to browse KV.</Hint>;
  }
  if (!jsEnabled) {
    return (
      <Hint>
        JetStream isn&apos;t enabled on this server. Start nats-server with{" "}
        <code className="rounded bg-accent px-1 py-0.5 font-mono">-js</code>.
      </Hint>
    );
  }

  const status = data?.status ?? "idle";
  const buckets = data?.buckets ?? [];
  const f = filter.trim().toLowerCase();
  const filtered = f
    ? buckets.filter((b) => b.bucket.toLowerCase().includes(f))
    : buckets;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-2 pb-1.5">
        <span className="text-[11px] text-muted-foreground">
          {buckets.length} {buckets.length === 1 ? "bucket" : "buckets"}
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Collapse all"
            title="Collapse all"
            onClick={() => collapseAll(connId)}
          >
            <ChevronsDownUp />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh"
            title="Refresh"
            onClick={() => void load(connId)}
          >
            <RefreshCw className={status === "loading" ? "animate-spin" : ""} />
          </Button>
        </div>
      </div>

      {status === "loading" && buckets.length === 0 ? (
        <EmptyState icon={Loader2} className="flex-1 [&>svg]:animate-spin">
          Loading buckets…
        </EmptyState>
      ) : status === "error" ? (
        <EmptyState icon={Database} variant="error" className="flex-1 gap-3">
          <span className="max-w-64 break-words">{data?.error}</span>
          <Button variant="outline" size="sm" onClick={() => void load(connId)}>
            <RefreshCw />
            Retry
          </Button>
        </EmptyState>
      ) : filtered.length === 0 ? (
        <Hint>{f ? "No matching buckets." : "No KV buckets yet."}</Hint>
      ) : (
        <KvTree connId={connId} buckets={filtered} />
      )}
    </div>
  );
}
