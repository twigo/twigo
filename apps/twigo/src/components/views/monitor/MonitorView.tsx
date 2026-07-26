import { useState } from "react";
import { RefreshCw, Activity, ShieldCheck, Plug } from "lucide-react";
import { Button, EmptyState, Input, Sparkline, cn } from "@twigo/ui";
import { fmtBytes, fmtCount } from "@twigo/utils";
import { useConnections } from "@/store/connections";
import { useMonitorConfig } from "@/store/monitorConfig";
import { openServerHealth } from "@/lib/editor";
import { useMonitorPoll, MONITOR_POLL_MS } from "@/hooks/useMonitorPoll";
import {
  useMonitor,
  rates,
  rateSeries,
  gaugeSeries,
  TOTAL_MSGS,
  TOTAL_BYTES,
  type Sample,
  type SeriesPoint,
} from "@/store/monitor";
import type { ViewProps } from "@/shell/views";
import type { Varz, Jsz, Healthz } from "@/lib/api";

const SPARK_WINDOW_MS = 15 * 60_000;
const SPARK_LABEL = "last 15m";
// A slow or failed poll shouldn't fracture the line; a real pause in sampling
// (the view was closed) should.
const SPARK_GAP_MS = MONITOR_POLL_MS * 4;

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

function SectionLabel({
  children,
  hint,
}: {
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      <span>{children}</span>
      {hint && (
        <span className="font-normal normal-case tracking-normal opacity-70">
          {hint}
        </span>
      )}
    </div>
  );
}

// The sidebar has room for a glance, not for reading a chart - so the whole row
// opens the full-size version in a tab.
function MetricRow({
  label,
  value,
  points,
  tone,
  onOpen,
}: {
  label: string;
  value: string;
  points: SeriesPoint[];
  tone?: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${label} — open full charts`}
      className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-xs hover:bg-row-hover focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
    >
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <div className={cn("min-w-8 flex-1", tone ?? "text-brand")}>
        <Sparkline
          points={points}
          windowMs={SPARK_WINDOW_MS}
          gapMs={SPARK_GAP_MS}
          height={24}
          label={`${label}, ${SPARK_LABEL}`}
        />
      </div>
      <span className="shrink-0 font-mono tabular-nums text-foreground">
        {value}
      </span>
    </button>
  );
}

function Dashboard({
  connId,
  varz,
  jsz,
  healthz,
  samples,
}: {
  connId: string;
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

      <SectionLabel hint={SPARK_LABEL}>Traffic</SectionLabel>
      <Row
        label="Connections"
        value={`${fmtCount(varz.connections)} (${fmtCount(varz.totalConnections)} total)`}
      />
      <MetricRow
        label="Throughput"
        value={r ? `${fmtCount(Math.round(r.msgsPerSec))}/s` : "-"}
        points={rateSeries(samples, TOTAL_MSGS)}
        onOpen={() => openServerHealth(connId)}
      />
      <MetricRow
        label="Data rate"
        value={r ? `${fmtBytes(r.bytesPerSec)}/s` : "-"}
        points={rateSeries(samples, TOTAL_BYTES)}
        onOpen={() => openServerHealth(connId)}
      />
      <Row label="Subscriptions" value={fmtCount(varz.subscriptions)} />
      <Row
        label="Slow consumers"
        value={fmtCount(varz.slowConsumers)}
        tone={varz.slowConsumers > 0 ? "text-warn" : undefined}
      />
      <button
        type="button"
        onClick={() => openServerHealth(connId)}
        className="mx-2 mt-1 flex w-[calc(100%-1rem)] items-center justify-center gap-1 rounded border border-border py-1 text-[11px] text-muted-foreground transition-colors hover:bg-row-hover hover:text-foreground"
      >
        Server health & charts →
      </button>

      <SectionLabel hint={SPARK_LABEL}>Resources</SectionLabel>
      <MetricRow
        label="Memory"
        value={fmtBytes(varz.mem)}
        points={gaugeSeries(samples, (s) => s.mem)}
        tone="text-muted-foreground"
        onOpen={() => openServerHealth(connId)}
      />
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

// $SYS metrics need a system-account login; when that's unavailable, let the
// user point Twigo at the server's HTTP monitoring port (:8222) instead. The
// URL lives in Twigo's own store (useMonitorConfig), not the nats context file.
function MonitoringSetup({
  connId,
  currentUrl,
  error,
}: {
  connId: string;
  currentUrl: string | null;
  error?: string | null;
}) {
  const [value, setValue] = useState(currentUrl ?? "");
  const setUrl = useMonitorConfig((s) => s.setUrl);
  const apply = (url: string | null) => {
    setUrl(connId, url);
    useMonitor.getState().reset(connId);
  };
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <Activity className="size-8 text-muted-foreground/40" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          {error ? "Monitoring unreachable" : "Monitoring off"}
        </p>
        <p className="mx-auto max-w-64 text-xs text-muted-foreground">
          {error ? (
            "Couldn't reach the HTTP monitoring endpoint. Check the URL and try again."
          ) : (
            <>
              This connection isn&apos;t a system-account login, so server
              metrics (<code className="font-mono">$SYS</code>) aren&apos;t
              available. If the server exposes its HTTP monitoring port, point
              Twigo at it:
            </>
          )}
        </p>
        {error && (
          <p className="mx-auto max-w-64 break-words font-mono text-[11px] text-error">
            {error}
          </p>
        )}
      </div>
      <form
        className="flex w-full max-w-64 flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          const v = value.trim();
          if (v) apply(v);
        }}
      >
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="http://127.0.0.1:8222"
          aria-label="HTTP monitoring URL"
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          type="submit"
          variant="brand"
          size="sm"
          disabled={!value.trim()}
        >
          <Plug className="size-3.5" />
          {error ? "Reconnect" : "Use HTTP monitoring"}
        </Button>
        {currentUrl && (
          <button
            type="button"
            onClick={() => apply(null)}
            className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Clear monitoring URL
          </button>
        )}
      </form>
    </div>
  );
}

export function MonitorView({ connId }: ViewProps) {
  const isConnected = useConnections((s) => !!(connId && s.connected[connId]));
  const monitoringUrl = useMonitorConfig((s) =>
    connId ? (s.urls[connId] ?? null) : null,
  );
  const data = useMonitor((s) => (connId ? s.byConn[connId] : undefined));
  useMonitorPoll(isConnected ? connId : null, monitoringUrl);

  if (!isConnected || !connId) {
    return (
      <EmptyState density="inline">
        Connect to a server to see its health.
      </EmptyState>
    );
  }

  const status = data?.status ?? "idle";

  if (status === "unavailable") {
    return <MonitoringSetup connId={connId} currentUrl={monitoringUrl} />;
  }

  if (status === "error") {
    // An HTTP URL is set but unreachable - let the user fix it in place.
    if (monitoringUrl) {
      return (
        <MonitoringSetup
          connId={connId}
          currentUrl={monitoringUrl}
          error={data?.error ?? null}
        />
      );
    }
    return (
      <EmptyState
        icon={Activity}
        variant="error"
        className="flex-1"
        action={{
          label: "Retry",
          onClick: () => void useMonitor.getState().poll(connId, monitoringUrl),
          icon: RefreshCw,
        }}
      >
        <span className="max-w-64 break-words">{data?.error}</span>
      </EmptyState>
    );
  }

  if (!data?.varz) {
    return (
      <EmptyState
        icon={Activity}
        className="flex-1"
        iconClassName="animate-pulse"
      >
        Reading server health…
      </EmptyState>
    );
  }

  return (
    <Dashboard
      connId={connId}
      varz={data.varz}
      jsz={data.jsz}
      healthz={data.healthz}
      samples={data.samples}
    />
  );
}
