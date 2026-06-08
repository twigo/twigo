import { Plus, RefreshCw, Loader2 } from "lucide-react";
import { useConnections } from "@/store/connections";
import { ConnectionRow } from "./ConnectionRow";

// The sidebar's connection manager: header actions + the list of contexts.
export function ConnectionsList() {
  const contexts = useConnections((s) => s.contexts);
  const status = useConnections((s) => s.status);
  const error = useConnections((s) => s.error);
  const load = useConnections((s) => s.load);

  return (
    <>
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Connections
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Reload nats contexts"
            title="Reload nats contexts"
            onClick={() => void load()}
            className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RefreshCw className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Add connection"
            title="Add connection"
            className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="space-y-0.5 px-1.5">
        {status === "loading" && (
          <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Loading contexts…
          </div>
        )}

        {status === "error" && (
          <p className="px-2 py-1.5 text-xs text-error">{error}</p>
        )}

        {status === "ready" && contexts.length === 0 && (
          <p className="px-2 py-2 text-xs leading-relaxed text-muted-foreground">
            No nats contexts found in{" "}
            <span className="font-mono">~/.config/nats/context</span>.
          </p>
        )}

        {contexts.map((c) => (
          <ConnectionRow key={c.name} context={c} />
        ))}
      </div>
    </>
  );
}
