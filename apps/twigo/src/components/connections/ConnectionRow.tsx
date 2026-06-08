import { Circle, Loader2, Unplug, PlugZap, Server } from "lucide-react";
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
import type { ContextSummary } from "@/lib/api";

// One connection in the sidebar list: pick/connect/disconnect, a five-state
// status dot, and a right-click menu. Reads its own row state by name.
export function ConnectionRow({ context: c }: { context: ContextSummary }) {
  const active = useConnections((s) => s.activeContext === c.name);
  const info = useConnections((s) => s.connected[c.name]);
  const isConnecting = useConnections((s) => !!s.connecting[c.name]);
  const err = useConnections((s) => s.connError[c.name]);
  const setActive = useConnections((s) => s.setActive);
  const connect = useConnections((s) => s.connect);
  const disconnect = useConnections((s) => s.disconnect);
  const isConnected = !!info;
  const isLive = info?.connected === true;

  return (
    <ContextMenu>
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
              err ?? `${c.url}${c.description ? ` — ${c.description}` : ""}`
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
}
