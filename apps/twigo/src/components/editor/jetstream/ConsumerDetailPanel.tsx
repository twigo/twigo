import { useEffect, useState } from "react";
import {
  RefreshCw,
  ArrowDownToLine,
  CloudOff,
  Pause,
  Play,
  Trash2,
} from "lucide-react";
import { Button, EmptyState, Sparkline, sparkSpan } from "@twigo/ui";
import { fmtCount, fmtDuration } from "@twigo/utils";
import { jsPauseConsumer, jsResumeConsumer, jsDeleteConsumer } from "@/lib/api";
import { useConsumerDetail } from "@/hooks/useJetStreamDetail";
import { useIsReadOnly } from "@/hooks/useIsReadOnly";
import { useConnections, selectServerVersion } from "@/store/connections";
import { useJetStream } from "@/store/jetstream";
import { useSeries, NO_POINTS, type SeriesPoint } from "@/store/series";
import { useToasts } from "@/store/toasts";
import { closeConsumerDetail } from "@/lib/editor";
import { Row, Section, RawJson, DetailSkeleton } from "./parts";
import { disp, num, supportsPause } from "./format";
import { ConfirmDialog } from "./ConfirmDialog";

function nanos(v: unknown): string {
  const n = num(v);
  if (n === null) return "-";
  if (n <= 0) return "-";
  if (n < 1e9) return `${Math.round(n / 1e6)}ms`;
  return `${Math.round(n / 1e9)}s`;
}
function filters(cfg: Record<string, unknown>): string {
  if (Array.isArray(cfg.filter_subjects) && cfg.filter_subjects.length) {
    return (cfg.filter_subjects as string[]).join(", ");
  }
  if (typeof cfg.filter_subject === "string" && cfg.filter_subject) {
    return cfg.filter_subject;
  }
  return "all";
}

const LAG_WINDOW_MS = 15 * 60_000;
// Four missed polls read as a real pause in sampling, not a slow round-trip.
const LAG_GAP_MS = 20_000;

function LagTrend({ points }: { points: SeriesPoint[] }) {
  if (points.length < 2) return null;
  // Sampling starts when the panel opens, so most of the axis is empty at first
  // - say how much of the window has actually been watched.
  const coveredMs = sparkSpan(points, LAG_WINDOW_MS);
  const covered = fmtDuration(coveredMs * 1e6);
  return (
    <div className="mb-2 border-b border-border pb-2">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Lag trend
        </span>
        <span className="flex items-baseline gap-1.5 text-[10px] text-muted-foreground">
          <span>last 15m</span>
          {coveredMs < LAG_WINDOW_MS && (
            <span className="opacity-70">{covered} sampled</span>
          )}
        </span>
      </div>
      <Sparkline
        points={points}
        windowMs={LAG_WINDOW_MS}
        gapMs={LAG_GAP_MS}
        height={40}
        // The number below carries the magnitude; this answers the other
        // question - whether the backlog is growing - and from zero a lag of
        // thousands is a filled box with no shape in it.
        baseline="auto"
        label="Unprocessed messages, last 15 minutes"
        className="text-brand"
      />
    </div>
  );
}

export function ConsumerDetailPanel({
  connId,
  stream,
  consumer,
}: {
  connId: string;
  stream: string;
  consumer: string;
}) {
  const { data, error, loading, staleReason, refresh } = useConsumerDetail(
    connId,
    stream,
    consumer,
  );
  const seriesKey = `consumer:${stream}:${consumer}`;
  const lag = useSeries((s) => s.byConn[connId]?.[seriesKey] ?? NO_POINTS);
  // Keyed on the read, not on the number: every poll is a sample, so a lag that
  // isn't moving draws a flat line instead of a gap.
  useEffect(() => {
    if (data) useSeries.getState().push(connId, seriesKey, data.numPending);
  }, [connId, seriesKey, data]);
  const serverVersion = useConnections(selectServerVersion(connId));
  const readOnly = useIsReadOnly(connId);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const cfg = data?.config ?? {};
  const canPause = supportsPause(serverVersion);

  const doPauseResume = async () => {
    try {
      if (data?.paused) {
        await jsResumeConsumer(connId, stream, consumer);
        useToasts.getState().push("success", `Resumed ${consumer}`);
      } else {
        await jsPauseConsumer(connId, stream, consumer);
        useToasts.getState().push("success", `Paused ${consumer}`);
      }
      refresh();
      void useJetStream.getState().refreshChildren(connId, stream);
      void useJetStream.getState().load(connId);
    } catch (e) {
      useToasts.getState().push("error", `Failed: ${String(e)}`);
    }
  };

  const doDelete = async () => {
    try {
      await jsDeleteConsumer(connId, stream, consumer);
      useToasts.getState().push("success", `Deleted consumer ${consumer}`);
      closeConsumerDetail(connId, stream, consumer);
      void useJetStream.getState().refreshChildren(connId, stream);
      void useJetStream.getState().load(connId);
    } catch (e) {
      useToasts.getState().push("error", `Delete failed: ${String(e)}`);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-editor">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <ArrowDownToLine className="size-3.5 text-brand" />
        <span className="ml-1 truncate font-mono text-[11px] font-medium">
          {consumer}
        </span>
        <span className="ml-1 truncate text-[11px] text-muted-foreground">
          on {stream}
        </span>
        {staleReason && (
          <span
            className="ml-1 inline-flex items-center gap-0.5 text-[11px] text-warn"
            title={`Live updates are failing: ${staleReason}`}
          >
            <CloudOff className="size-3" /> stale
          </span>
        )}
        {data?.paused && (
          <span className="ml-1 inline-flex items-center gap-0.5 text-[11px] text-warn">
            <Pause className="size-3" /> paused
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {data && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={data.paused ? "Resume consumer" : "Pause consumer"}
              title={
                readOnly
                  ? "Connection is read-only"
                  : canPause
                    ? data.paused
                      ? "Resume consumer"
                      : "Pause consumer"
                    : "Pause/resume requires NATS Server 2.11+"
              }
              disabled={!canPause || readOnly}
              onClick={() => void doPauseResume()}
            >
              {data.paused ? <Play /> : <Pause />}
            </Button>
          )}
          {data && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Delete consumer"
              title={readOnly ? "Connection is read-only" : "Delete consumer"}
              className="text-error"
              disabled={readOnly}
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh"
            title="Refresh"
            onClick={refresh}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete consumer ${consumer}?`}
        description="This permanently removes the consumer and its position. Messages stay in the stream."
        confirmLabel="Delete consumer"
        confirmWord={consumer}
        onConfirm={() => void doDelete()}
      />

      {error ? (
        <EmptyState
          icon={ArrowDownToLine}
          variant="error"
          className="flex-1 gap-3"
        >
          <span className="max-w-72 break-words">{error}</span>
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCw />
            Retry
          </Button>
        </EmptyState>
      ) : !data ? (
        <DetailSkeleton />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3">
          <Section title="State">
            <LagTrend points={lag} />
            <Row
              label="Unprocessed (lag)"
              value={
                <span className={data.numPending > 0 ? "text-warn" : ""}>
                  {fmtCount(data.numPending)}
                </span>
              }
            />
            <Row label="In-flight (ack pending)" value={data.numAckPending} />
            <Row label="Redelivered" value={data.numRedelivered} />
            <Row label="Waiting pulls" value={data.numWaiting} />
            <Row
              label="Delivered (cons/strm)"
              value={`${data.deliveredConsumerSeq} / ${data.deliveredStreamSeq}`}
            />
            <Row
              label="Ack floor (cons/strm)"
              value={`${data.ackFloorConsumerSeq} / ${data.ackFloorStreamSeq}`}
            />
          </Section>

          <Section title="Config">
            <Row label="Durable" value={disp(cfg.durable_name)} />
            <Row label="Deliver policy" value={disp(cfg.deliver_policy)} />
            <Row label="Ack policy" value={disp(cfg.ack_policy)} />
            <Row label="Ack wait" value={nanos(cfg.ack_wait)} />
            <Row label="Max deliver" value={disp(cfg.max_deliver)} />
            <Row label="Filter" value={filters(cfg)} />
            <Row label="Replay policy" value={disp(cfg.replay_policy)} />
            <Row label="Max ack pending" value={disp(cfg.max_ack_pending)} />
            <Row
              label="Inactive threshold"
              value={nanos(cfg.inactive_threshold)}
            />
          </Section>

          <RawJson value={data.config} />
        </div>
      )}
    </div>
  );
}
