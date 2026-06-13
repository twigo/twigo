import { useEffect, useState } from "react";
import {
  RefreshCw,
  Loader2,
  Activity,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import {
  Button,
  EmptyState,
  cn,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@twigo/ui";
import { fmtBytes, fmtCount } from "@twigo/utils";
import { monitorConnz, monitorCluster, type Connz, type Varz } from "@/lib/api";
import { useMonitorConfig } from "@/store/monitorConfig";

const LIMIT = 100;

interface Col {
  label: string;
  sort?: string;
  align?: "right";
}
const COLS: Col[] = [
  { label: "CID", sort: "cid", align: "right" },
  { label: "Client" },
  { label: "IP" },
  { label: "Subs", sort: "subs", align: "right" },
  { label: "Pending", sort: "pending", align: "right" },
  { label: "In", sort: "msgs_from", align: "right" },
  { label: "Out", sort: "msgs_to", align: "right" },
  { label: "RTT", sort: "rtt", align: "right" },
  { label: "Idle", sort: "idle", align: "right" },
];

export function ServerHealthPanel({ connId }: { connId: string }) {
  const monitoringUrl = useMonitorConfig((s) => s.urls[connId] ?? null);
  const [sort, setSort] = useState("pending");
  const [offset, setOffset] = useState(0);
  const [tick, setTick] = useState(0);
  const [connz, setConnz] = useState<Connz | null>(null);
  const [cluster, setCluster] = useState<Varz[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    monitorConnz(connId, sort, LIMIT, offset, monitoringUrl)
      .then((c) => {
        if (!cancelled) {
          setConnz(c);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connId, sort, offset, tick, monitoringUrl]);

  useEffect(() => {
    let cancelled = false;
    monitorCluster(connId, monitoringUrl)
      .then((c) => {
        if (!cancelled) setCluster(c);
      })
      .catch(() => {
        if (!cancelled) setCluster([]);
      });
    return () => {
      cancelled = true;
    };
  }, [connId, tick, monitoringUrl]);

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") setTick((t) => t + 1);
    }, 5000);
    return () => clearInterval(id);
  }, []);

  const rows = connz?.connections ?? [];
  const total = connz?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = offset + rows.length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <Activity className="size-3.5 text-brand" />
        <span className="text-[11px] font-medium">Connections</span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {fmtCount(total)}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh"
          title="Refresh"
          className="ml-auto"
          onClick={() => setTick((t) => t + 1)}
        >
          <RefreshCw className={loading ? "animate-spin" : ""} />
        </Button>
      </div>

      {cluster.length > 1 && (
        <div className="flex flex-wrap gap-1.5 border-b border-border px-3 py-2">
          {cluster.map((n) => {
            const warn = n.slowConsumers > 0 || n.lameDuckMode;
            return (
              <div
                key={n.serverId}
                className="flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[11px]"
                title={`${n.serverName} · ${n.version} · up ${n.uptime}`}
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    warn ? "bg-warn" : "bg-ok",
                  )}
                />
                <span className="font-mono">{n.serverName}</span>
                <span className="tabular-nums text-muted-foreground">
                  {fmtCount(n.connections)} conns
                </span>
                {n.slowConsumers > 0 && (
                  <span className="tabular-nums text-warn">
                    {n.slowConsumers} slow
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {error ? (
        <EmptyState
          icon={Activity}
          variant="error"
          className="flex-1"
          action={{
            label: "Retry",
            onClick: () => setTick((t) => t + 1),
            icon: RefreshCw,
          }}
        >
          <span className="max-w-md break-words">{error}</span>
        </EmptyState>
      ) : !connz ? (
        <EmptyState icon={Loader2} className="flex-1 [&>svg]:animate-spin">
          Reading connections…
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState icon={Activity} className="flex-1">
          No connections.
        </EmptyState>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-panel">
              <TableRow>
                {COLS.map((c) => {
                  const active = c.sort === sort;
                  return (
                    <TableHead
                      key={c.label}
                      className={cn(
                        "whitespace-nowrap",
                        c.align === "right" && "text-right",
                        c.sort &&
                          "cursor-pointer select-none hover:text-foreground",
                        active && "text-foreground",
                      )}
                      onClick={() => {
                        if (!c.sort) return;
                        setOffset(0);
                        setSort(c.sort);
                      }}
                    >
                      <span className="inline-flex items-center gap-0.5">
                        {c.label}
                        {active && <ChevronDown className="size-3" />}
                      </span>
                    </TableHead>
                  );
                })}
              </TableRow>
            </TableHeader>
            <TableBody className="font-mono">
              {rows.map((r) => (
                <TableRow
                  key={r.cid}
                  className="border-b border-border/50 hover:bg-row-hover"
                >
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {r.cid}
                  </TableCell>
                  <TableCell className="max-w-48 truncate">
                    {r.name || "-"}
                    {r.lang && (
                      <span className="ml-1 text-muted-foreground">
                        {r.lang}
                        {r.version ? ` ${r.version}` : ""}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.ip}:{r.port}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmtCount(r.subscriptions)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums",
                      r.pendingBytes > 0
                        ? "text-warn"
                        : "text-muted-foreground",
                    )}
                  >
                    {fmtBytes(r.pendingBytes)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {fmtCount(r.inMsgs)} · {fmtBytes(r.inBytes)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {fmtCount(r.outMsgs)} · {fmtBytes(r.outBytes)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {r.rtt || "-"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {r.idle}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {connz && total > 0 && (
        <div className="flex h-7 shrink-0 items-center gap-2 border-t border-border px-3 text-[11px] text-muted-foreground">
          <span className="tabular-nums">
            {from}-{to} of {fmtCount(total)}
          </span>
          <div className="ml-auto flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - LIMIT))}
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Next"
              disabled={to >= total}
              onClick={() => setOffset(offset + LIMIT)}
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
