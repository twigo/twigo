import { useEffect, useState } from "react";
import { RefreshCw, Server, ArrowUp, ArrowDown } from "lucide-react";
import { Button, EmptyState, cn } from "@twigo/ui";
import { fmtCount, fmtLatency, fmtRelTime } from "@twigo/utils";
import { useConnections } from "@/store/connections";
import { useServices } from "@/store/services";
import { openService } from "@/lib/editor";
import {
  aggregate,
  sortServices,
  matchesServiceFilter,
  type ServiceSortKey,
  type SortDir,
} from "@/lib/serviceStats";
import type { ViewProps } from "@/shell/views";

function fmtUptime(started: string): string {
  const ms = Date.parse(started);
  return Number.isNaN(ms) ? "-" : fmtRelTime(ms);
}

export function ServicesView({ filter, connId }: ViewProps) {
  const isConnected = useConnections((s) => !!(connId && s.connected[connId]));
  const data = useServices((s) => (connId ? s.byConn[connId] : undefined));
  const [sortKey, setSortKey] = useState<ServiceSortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  // Discover on first open / connection change; teardown is conn-scoped.
  useEffect(() => {
    if (isConnected && connId) void useServices.getState().discover(connId);
  }, [isConnected, connId]);

  if (!isConnected || !connId) {
    return (
      <EmptyState density="inline">
        Connect to a server to list its micro services.
      </EmptyState>
    );
  }

  const status = data?.status ?? "idle";
  const services = data?.services ?? [];
  const error = data?.error ?? null;
  const discover = () => void useServices.getState().discover(connId);

  const toggleSort = (key: ServiceSortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };

  const rows = sortServices(
    services.filter((s) => matchesServiceFilter(s, filter)),
    sortKey,
    sortDir,
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
        <Server className="size-3.5 text-muted-foreground" />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Services
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {status === "ready" ? fmtCount(services.length) : ""}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label="Refresh"
          title="Rediscover services"
          disabled={status === "loading"}
          onClick={discover}
        >
          <RefreshCw className={status === "loading" ? "animate-spin" : ""} />
        </Button>
      </div>

      {status === "loading" && services.length === 0 ? (
        <EmptyState
          icon={Server}
          className="min-h-0 flex-1"
          iconClassName="animate-pulse"
        >
          Discovering services…
        </EmptyState>
      ) : status === "error" ? (
        <EmptyState
          icon={Server}
          variant="error"
          className="min-h-0 flex-1"
          action={{ label: "Retry", onClick: discover, icon: RefreshCw }}
        >
          <span className="max-w-64 break-words">{error}</span>
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Server}
          className="min-h-0 flex-1"
          action={{ label: "Rediscover", onClick: discover, icon: RefreshCw }}
        >
          {services.length === 0
            ? "No micro services responded on $SRV.STATS."
            : `No services match “${filter.trim()}”.`}
        </EmptyState>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-background">
              <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <Th
                  label="Service"
                  col="name"
                  {...{ sortKey, sortDir, toggleSort }}
                />
                <th className="px-2 py-1 font-medium">Instance</th>
                <Th
                  label="Uptime"
                  col="uptime"
                  align="right"
                  {...{ sortKey, sortDir, toggleSort }}
                />
                <Th
                  label="Requests"
                  col="requests"
                  align="right"
                  {...{ sortKey, sortDir, toggleSort }}
                />
                <Th
                  label="Errors"
                  col="errors"
                  align="right"
                  {...{ sortKey, sortDir, toggleSort }}
                />
                <Th
                  label="Avg"
                  col="avg"
                  align="right"
                  {...{ sortKey, sortDir, toggleSort }}
                />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const a = aggregate(s);
                return (
                  <tr
                    key={`${s.name} ${s.id}`}
                    onClick={() => {
                      openService(connId, s.name, s.id);
                    }}
                    title="Open service detail"
                    className="cursor-pointer border-b border-border/50 hover:bg-row-hover"
                  >
                    <td className="px-2 py-1">
                      <span className="font-mono">{s.name}</span>
                      {s.version && (
                        <span className="ml-1.5 text-[10px] text-muted-foreground">
                          v{s.version}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1 font-mono text-[11px] text-muted-foreground">
                      {s.id}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                      {fmtUptime(s.started)}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">
                      {fmtCount(a.requests)}
                    </td>
                    <td
                      className={cn(
                        "px-2 py-1 text-right tabular-nums",
                        a.errors > 0 ? "text-error" : "text-muted-foreground",
                      )}
                    >
                      {fmtCount(a.errors)}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">
                      {fmtLatency(a.avgProcessingNs)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Th({
  label,
  col,
  align = "left",
  sortKey,
  sortDir,
  toggleSort,
}: {
  label: string;
  col: ServiceSortKey;
  align?: "left" | "right";
  sortKey: ServiceSortKey;
  sortDir: SortDir;
  toggleSort: (key: ServiceSortKey) => void;
}) {
  const active = sortKey === col;
  return (
    <th
      className="px-2 py-1 font-medium"
      aria-sort={
        active ? (sortDir === "asc" ? "ascending" : "descending") : "none"
      }
    >
      <button
        type="button"
        onClick={() => toggleSort(col)}
        className={cn(
          "flex items-center gap-0.5 uppercase tracking-wider hover:text-foreground",
          align === "right" && "ml-auto flex-row-reverse",
          active && "text-foreground",
        )}
      >
        {label}
        {active &&
          (sortDir === "asc" ? (
            <ArrowUp className="size-3" />
          ) : (
            <ArrowDown className="size-3" />
          ))}
      </button>
    </th>
  );
}
