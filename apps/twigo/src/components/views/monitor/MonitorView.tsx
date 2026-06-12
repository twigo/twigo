import { useEffect } from "react";
import { RefreshCw, Activity, ShieldCheck } from "lucide-react";
import { EmptyState, cn } from "@twigo/ui";
import { fmtBytes, fmtCount } from "@twigo/utils";
import { useConnections } from "@/store/connections";
import { useMonitor, rates, type Sample } from "@/store/monitor";
import type { ViewProps } from "@/components/views/registry";
import type { Varz, Jsz, Healthz } from "@/lib/api";

function useMonitorPoll(connId: string | null, intervalMs = 3000) {
  const poll = useMonitor((s) => s.poll);
  useEffect(() => {
    if (!connId) return;
    const tick = () => {
      if (document.visibilityState === "visible") void poll(connId);
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [connId, intervalMs, poll]);
}

type Verdict = "ok" | "warn" | "error";

function verdict(
  varz: Varz,
  jsz: Jsz | null,
  healthz: Healthz | null,
): Verdict {
  if (healthz && healthz.status !== "ok") return "error";
  const storeFull =
    jsz && jsz.config.maxStorage > 0
      ? jsz.storage / jsz.config.maxStorage > 0.9
      : false;
  if (varz.slowConsumers > 0 || varz.lameDuckMode || storeFull) return "warn";
  return "ok";
}

const VERDICT: Record<Verdict, { label: string; fg: string; dot: string }> = {
  ok: { label: "Healthy", fg: "text-ok", dot: "bg-ok" },
  warn: { label: "Degraded", fg: "text-warn", dot: "bg-warn" },
  error: { label: "Unhealthy", fg: "text-error", dot: "bg-error" },
};

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 px-2 py-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-mono tabular-nums", tone ?? "text-foreground")}>
        {value}
      </span>
    </div>
  );
}

function UsageBar({
  used,
  max,
  label,
}: {
  used: number;
  max: number;
  label: string;
}) {
  const unlimited = max <= 0;
  const pct = unlimited ? 0 : Math.min(100, (used / max) * 100);
  const tone = pct > 90 ? "bg-error" : pct > 75 ? "bg-warn" : "bg-brand";
  return (
    <div className="px-2 py-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono tabular-nums text-foreground">
          {fmtBytes(used)}
          <span className="text-muted-foreground">
            {unlimited ? " / ∞" : ` / ${fmtBytes(max)}`}
          </span>
        </span>
      </div>
      {!unlimited && (
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full transition-all", tone)}
            style={{ width: `${String(pct)}%` }}
          />
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

function Dashboard({
  varz,
  jsz,
  healthz,
  samples,
}: {
  varz: Varz;
  jsz: Jsz | null;
  healthz: Healthz | null;
  samples: Sample[];
}) {
  const v = verdict(varz, jsz, healthz);
  const badge = VERDICT[v];
  const r = rates(samples);
  return (
    <div className="min-h-0 flex-1 overflow-auto pb-2">
      <div className="mx-2 my-1.5 flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5">
        <ShieldCheck className={cn("size-4", badge.fg)} />
        <span className={cn("text-xs font-medium", badge.fg)}>
          {badge.label}
        </span>
        <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground">
          <span className="size-1.5 animate-pulse rounded-full bg-ok" />
          live
        </span>
      </div>

      <SectionLabel>Server</SectionLabel>
      <Row
        label={varz.serverName}
        value={`v${varz.version} · up ${varz.uptime}`}
      />
      {varz.cluster.name && <Row label="Cluster" value={varz.cluster.name} />}

      <SectionLabel>Traffic</SectionLabel>
      <Row
        label="Connections"
        value={`${fmtCount(varz.connections)} (${fmtCount(varz.totalConnections)} total)`}
      />
      <Row
        label="Throughput"
        value={r ? `${fmtCount(Math.round(r.msgsPerSec))}/s` : "—"}
      />
      <Row label="Data rate" value={r ? `${fmtBytes(r.bytesPerSec)}/s` : "—"} />
      <Row label="Subscriptions" value={fmtCount(varz.subscriptions)} />
      <Row
        label="Slow consumers"
        value={fmtCount(varz.slowConsumers)}
        tone={varz.slowConsumers > 0 ? "text-warn" : undefined}
      />

      <SectionLabel>Resources</SectionLabel>
      <Row label="Memory" value={fmtBytes(varz.mem)} />
      <Row label="CPU" value={`${varz.cpu.toFixed(0)}%`} />

      {jsz && (
        <>
          <SectionLabel>JetStream</SectionLabel>
          <UsageBar
            used={jsz.memory}
            max={jsz.config.maxMemory}
            label="Memory"
          />
          <UsageBar
            used={jsz.storage}
            max={jsz.config.maxStorage}
            label="Storage"
          />
          <Row
            label="Streams · Consumers"
            value={`${fmtCount(jsz.streams)} · ${fmtCount(jsz.consumers)}`}
          />
          <Row
            label="Messages"
            value={`${fmtCount(jsz.messages)} (${fmtBytes(jsz.bytes)})`}
          />
          <Row
            label="API errors"
            value={fmtCount(jsz.api.errors)}
            tone={jsz.api.errors > 0 ? "text-warn" : undefined}
          />
        </>
      )}
    </div>
  );
}

export function MonitorView({ connId }: ViewProps) {
  const isConnected = useConnections((s) => !!(connId && s.connected[connId]));
  const data = useMonitor((s) => (connId ? s.byConn[connId] : undefined));
  useMonitorPoll(isConnected ? connId : null);

  if (!isConnected || !connId) {
    return (
      <EmptyState density="inline">
        Connect to a server to see its health.
      </EmptyState>
    );
  }

  const status = data?.status ?? "idle";

  if (status === "unavailable") {
    return (
      <EmptyState icon={Activity} className="flex-1" title="Monitoring off">
        <p className="max-w-64 text-xs">
          This connection isn&apos;t a system-account login, so server metrics (
          <code className="font-mono">$SYS</code>) aren&apos;t available.
          Connect with a system-account user to see them.
        </p>
      </EmptyState>
    );
  }

  if (status === "error") {
    return (
      <EmptyState
        icon={Activity}
        variant="error"
        className="flex-1"
        action={{
          label: "Retry",
          onClick: () => void useMonitor.getState().poll(connId),
          icon: RefreshCw,
        }}
      >
        <span className="max-w-64 break-words">{data?.error}</span>
      </EmptyState>
    );
  }

  if (!data?.varz) {
    return (
      <EmptyState icon={Activity} className="flex-1 [&>svg]:animate-pulse">
        Reading server health…
      </EmptyState>
    );
  }

  return (
    <Dashboard
      varz={data.varz}
      jsz={data.jsz}
      healthz={data.healthz}
      samples={data.samples}
    />
  );
}
