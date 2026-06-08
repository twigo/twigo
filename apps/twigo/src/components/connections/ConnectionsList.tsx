import {
  Circle,
  Plus,
  RefreshCw,
  Loader2,
  Unplug,
  PlugZap,
  Server,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  cn,
} from "@twigo/ui";
import { useConnections } from "@/store/connections";
import { openServerInfo } from "@/lib/editor";

// The sidebar's connection manager: pick/connect/disconnect contexts, live
// status dot, and a right-click menu (server info / connect / disconnect).
export function ConnectionsList() {
  const {
    contexts,
    status,
    error,
    activeContext,
    connected,
    connecting,
    connError,
    load,
    setActive,
    connect,
    disconnect,
  } = useConnections();

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

        {contexts.map((c) => {
          const active = activeContext === c.name;
          const info = connected[c.name];
          const isConnected = !!info;
          const isLive = info?.connected === true;
          const isConnecting = !!connecting[c.name];
          const err = connError[c.name];
          return (
            <ContextMenu key={c.name}>
              <ContextMenuTrigger asChild>
                <div
                  className={cn(
                    "group relative flex h-7 w-full items-center rounded-md transition-colors",
                    active ? "bg-accent" : "hover:bg-accent/50",
                  )}
                >
                  {active && (
                    <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-brand" />
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      if (isConnected) {
                        setActive(c.name);
                      } else {
                        void connect(c.name);
                      }
                    }}
                    aria-current={active ? "true" : undefined}
                    title={
                      err ??
                      `${c.url}${c.description ? ` — ${c.description}` : ""}`
                    }
                    className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {isConnecting ? (
                      <Loader2 className="size-2.5 shrink-0 animate-spin text-muted-foreground" />
                    ) : (
                      <Circle
                        className={cn(
                          "size-2 shrink-0",
                          isLive
                            ? "fill-ok text-ok"
                            : isConnected
                              ? "animate-pulse fill-warn text-warn"
                              : err
                                ? "fill-error text-error"
                                : "fill-muted-foreground/40 text-muted-foreground/40",
                        )}
                      />
                    )}
                    <span className="flex-1 truncate text-xs font-medium">
                      {c.name}
                      {c.selected && (
                        <span className="ml-1 text-[11px] font-normal text-brand">
                          ★
                        </span>
                      )}
                    </span>
                    {!isConnected && (
                      <span className="truncate font-mono text-[11px] text-muted-foreground">
                        {c.url.replace(/^\w+:\/\//, "")}
                      </span>
                    )}
                  </button>
                  {isConnected && (
                    <button
                      type="button"
                      aria-label={`Disconnect ${c.name}`}
                      title="Disconnect"
                      onClick={() => void disconnect(c.name)}
                      className="mr-1 flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-error focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
                    >
                      <Unplug className="size-3" />
                    </button>
                  )}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuLabel>{c.name}</ContextMenuLabel>
                <ContextMenuItem
                  disabled={!isLive}
                  onSelect={() => {
                    openServerInfo(c.name);
                  }}
                >
                  <Server />
                  Server info
                </ContextMenuItem>
                <ContextMenuSeparator />
                {isConnected ? (
                  <ContextMenuItem
                    variant="destructive"
                    onSelect={() => void disconnect(c.name)}
                  >
                    <Unplug />
                    Disconnect
                  </ContextMenuItem>
                ) : (
                  <ContextMenuItem onSelect={() => void connect(c.name)}>
                    <PlugZap />
                    Connect
                  </ContextMenuItem>
                )}
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>
    </>
  );
}
