import { useEffect, useState } from "react";
import { RefreshCw, ChevronsDownUp, Database, Plus } from "lucide-react";
import { Button, EmptyState } from "@twigo/ui";
import { kvCreateBucket } from "@/lib/api";
import { useConnections } from "@/store/connections";
import { useKv } from "@/store/kv";
import { useToasts } from "@/store/toasts";
import type { ViewProps } from "@/shell/views";
import { TreeSkeleton } from "@/components/views/TreeSkeleton";
import { KvTree } from "./KvTree";
import { CreateBucketDialog } from "@/components/editor/kv/CreateBucketDialog";

export function KvView({ filter, connId }: ViewProps) {
  const isConnected = useConnections((s) => !!(connId && s.connected[connId]));
  const jsEnabled = useConnections((s) =>
    connId ? (s.connected[connId]?.jetstream ?? false) : false,
  );
  const data = useKv((s) => (connId ? s.byConn[connId] : undefined));
  const load = useKv((s) => s.load);
  const collapseAll = useKv((s) => s.collapseAll);
  const [createOpen, setCreateOpen] = useState(false);

  const doCreate = async (config: Record<string, unknown>) => {
    if (!connId) return;
    try {
      await kvCreateBucket(connId, config);
      useToasts
        .getState()
        .push("success", `Created bucket ${String(config.bucket)}`);
      void load(connId);
    } catch (e) {
      useToasts.getState().push("error", `Create failed: ${String(e)}`);
    }
  };

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
    return (
      <EmptyState density="inline">
        Connect to a server to browse KV.
      </EmptyState>
    );
  }
  if (!jsEnabled) {
    return (
      <EmptyState density="inline">
        JetStream isn&apos;t enabled on this server. Start nats-server with{" "}
        <code className="rounded bg-accent px-1 py-0.5 font-mono">-js</code>.
      </EmptyState>
    );
  }

  const status = data?.status ?? "idle";
  const buckets = data?.parents ?? [];
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
            aria-label="New bucket"
            title="New bucket"
            onClick={() => setCreateOpen(true)}
          >
            <Plus />
          </Button>
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
        <TreeSkeleton />
      ) : status === "error" ? (
        <EmptyState
          icon={Database}
          variant="error"
          className="flex-1"
          action={{
            label: "Retry",
            onClick: () => void load(connId),
            icon: RefreshCw,
          }}
        >
          <span className="max-w-64 break-words">{data?.error}</span>
        </EmptyState>
      ) : filtered.length === 0 ? (
        f ? (
          <EmptyState density="inline">
            No buckets match “{filter.trim()}”.
          </EmptyState>
        ) : (
          <EmptyState
            icon={Database}
            className="flex-1"
            title="No KV buckets"
            action={{
              label: "New bucket",
              onClick: () => setCreateOpen(true),
              icon: Plus,
            }}
          >
            This context has no KV buckets yet.
          </EmptyState>
        )
      ) : (
        <KvTree connId={connId} buckets={filtered} />
      )}

      {createOpen && (
        <CreateBucketDialog
          onClose={() => setCreateOpen(false)}
          onCreate={(config) => void doCreate(config)}
        />
      )}
    </div>
  );
}
