import { useEffect, useState } from "react";
import { RefreshCw, ChevronsDownUp, Layers, Plus } from "lucide-react";
import { Button, EmptyState } from "@twigo/ui";
import { jsCreateStream } from "@/lib/api";
import { useIsReadOnly } from "@/hooks/useIsReadOnly";
import { useConnections } from "@/store/connections";
import { useJetStream } from "@/store/jetstream";
import { useToasts } from "@/store/toasts";
import type { ViewProps } from "@/shell/views";
import { TreeSkeleton } from "@/components/views/TreeSkeleton";
import { StreamTree } from "./StreamTree";
import { StreamFormDialog } from "@/components/editor/jetstream/StreamFormDialog";

export function JetStreamView({ filter, connId }: ViewProps) {
  const isConnected = useConnections((s) => !!(connId && s.connected[connId]));
  const jsEnabled = useConnections((s) =>
    connId ? (s.connected[connId]?.jetstream ?? false) : false,
  );
  const data = useJetStream((s) => (connId ? s.byConn[connId] : undefined));
  const load = useJetStream((s) => s.load);
  const collapseAll = useJetStream((s) => s.collapseAll);
  const readOnly = useIsReadOnly(connId);
  const [createOpen, setCreateOpen] = useState(false);

  const doCreate = async (config: Record<string, unknown>) => {
    if (!connId || readOnly) return;
    try {
      await jsCreateStream(connId, config);
      useToasts
        .getState()
        .push("success", `Created stream ${String(config.name)}`);
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
        Connect to a server to browse JetStream.
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
  const streams = data?.parents ?? [];
  const f = filter.trim().toLowerCase();
  const filtered = f
    ? streams.filter((s) => s.name.toLowerCase().includes(f))
    : streams;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-2 pb-1.5">
        <span className="text-[11px] text-muted-foreground">
          {streams.length} {streams.length === 1 ? "stream" : "streams"}
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            aria-label="New stream"
            title={readOnly ? "Connection is read-only" : "New stream"}
            disabled={readOnly}
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

      {status === "loading" && streams.length === 0 ? (
        <TreeSkeleton />
      ) : status === "error" ? (
        <EmptyState
          icon={Layers}
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
            No streams match “{filter.trim()}”.
          </EmptyState>
        ) : (
          <EmptyState
            icon={Layers}
            className="flex-1"
            title="No streams"
            action={
              readOnly
                ? undefined
                : {
                    label: "New stream",
                    onClick: () => setCreateOpen(true),
                    icon: Plus,
                  }
            }
          >
            This context has no JetStream streams yet.
          </EmptyState>
        )
      ) : (
        <StreamTree connId={connId} streams={filtered} />
      )}

      {createOpen && (
        <StreamFormDialog
          title="New stream"
          submitLabel="Create stream"
          onClose={() => setCreateOpen(false)}
          onSubmit={(config) => void doCreate(config)}
        />
      )}
    </div>
  );
}
