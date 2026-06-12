import { useEffect, useState } from "react";
import { RefreshCw, ChevronsDownUp, Loader2, Box, Plus } from "lucide-react";
import { Button, EmptyState } from "@twigo/ui";
import { objCreateBucket } from "@/lib/api";
import { useConnections } from "@/store/connections";
import { useObjStore } from "@/store/objstore";
import { useToasts } from "@/store/toasts";
import type { ViewProps } from "@/components/views/registry";
import { ObjectTree } from "./ObjectTree";
import { CreateObjBucketDialog } from "@/components/editor/objstore/CreateObjBucketDialog";

export function ObjectStoreView({ filter, connId }: ViewProps) {
  const isConnected = useConnections((s) => !!(connId && s.connected[connId]));
  const jsEnabled = useConnections((s) =>
    connId ? (s.connected[connId]?.jetstream ?? false) : false,
  );
  const data = useObjStore((s) => (connId ? s.byConn[connId] : undefined));
  const load = useObjStore((s) => s.load);
  const collapseAll = useObjStore((s) => s.collapseAll);
  const [createOpen, setCreateOpen] = useState(false);

  const doCreate = async (config: Record<string, unknown>) => {
    if (!connId) return;
    try {
      await objCreateBucket(connId, config);
      useToasts
        .getState()
        .push("info", `Created object store ${String(config.bucket)}`);
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
        Connect to a server to browse object stores.
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
  const buckets = data?.buckets ?? [];
  const f = filter.trim().toLowerCase();
  const filtered = f
    ? buckets.filter((b) => b.bucket.toLowerCase().includes(f))
    : buckets;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-2 pb-1.5">
        <span className="text-[11px] text-muted-foreground">
          {buckets.length} {buckets.length === 1 ? "store" : "stores"}
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            aria-label="New object store"
            title="New object store"
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
        <EmptyState icon={Loader2} className="flex-1 [&>svg]:animate-spin">
          Loading object stores…
        </EmptyState>
      ) : status === "error" ? (
        <EmptyState
          icon={Box}
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
            No stores match “{filter.trim()}”.
          </EmptyState>
        ) : (
          <EmptyState
            icon={Box}
            className="flex-1"
            title="No object stores"
            action={{
              label: "New object store",
              onClick: () => setCreateOpen(true),
              icon: Plus,
            }}
          >
            This context has no object stores yet.
          </EmptyState>
        )
      ) : (
        <ObjectTree connId={connId} buckets={filtered} />
      )}

      {createOpen && (
        <CreateObjBucketDialog
          onClose={() => setCreateOpen(false)}
          onCreate={(config) => void doCreate(config)}
        />
      )}
    </div>
  );
}
