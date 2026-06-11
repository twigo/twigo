import { useEffect, useState } from "react";
import { RefreshCw, ChevronsDownUp, Loader2, Layers, Plus } from "lucide-react";
import { Button, EmptyState } from "@twigo/ui";
import { jsCreateStream } from "@/lib/api";
import { useConnections } from "@/store/connections";
import { useJetStream } from "@/store/jetstream";
import { useToasts } from "@/store/toasts";
import type { ViewProps } from "@/components/views/registry";
import { StreamTree } from "./StreamTree";
import { CreateStreamDialog } from "@/components/editor/jetstream/CreateStreamDialog";

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}

export function JetStreamView({ filter, connId }: ViewProps) {
  const isConnected = useConnections((s) => !!(connId && s.connected[connId]));
  const jsEnabled = useConnections((s) =>
    connId ? (s.connected[connId]?.jetstream ?? false) : false,
  );
  const data = useJetStream((s) => (connId ? s.byConn[connId] : undefined));
  const load = useJetStream((s) => s.load);
  const collapseAll = useJetStream((s) => s.collapseAll);
  const [createOpen, setCreateOpen] = useState(false);

  const doCreate = async (config: Record<string, unknown>) => {
    if (!connId) return;
    try {
      await jsCreateStream(connId, config);
      useToasts
        .getState()
        .push("info", `Created stream ${String(config.name)}`);
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
    return <Hint>Connect to a server to browse JetStream.</Hint>;
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
  const streams = data?.streams ?? [];
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
            title="New stream"
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
        <EmptyState icon={Loader2} className="flex-1 [&>svg]:animate-spin">
          Loading streams…
        </EmptyState>
      ) : status === "error" ? (
        <EmptyState icon={Layers} variant="error" className="flex-1 gap-3">
          <span className="max-w-64 break-words">{data?.error}</span>
          <Button variant="outline" size="sm" onClick={() => void load(connId)}>
            <RefreshCw />
            Retry
          </Button>
        </EmptyState>
      ) : filtered.length === 0 ? (
        <Hint>{f ? "No matching streams." : "No streams yet."}</Hint>
      ) : (
        <StreamTree connId={connId} streams={filtered} />
      )}

      {createOpen && (
        <CreateStreamDialog
          onClose={() => setCreateOpen(false)}
          onCreate={(config) => void doCreate(config)}
        />
      )}
    </div>
  );
}
