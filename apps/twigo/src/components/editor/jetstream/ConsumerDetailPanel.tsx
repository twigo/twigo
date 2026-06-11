import { RefreshCw, Loader2, ArrowDownToLine, Pause } from "lucide-react";
import { Button, EmptyState } from "@twigo/ui";
import { fmtCount } from "@twigo/utils";
import { useConsumerDetail } from "@/hooks/useJetStreamDetail";
import { Row, Section, RawJson } from "./parts";
import { disp, num } from "./format";

function nanos(v: unknown): string {
  const n = num(v);
  if (n === null) return "—";
  if (n <= 0) return "—";
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

export function ConsumerDetailPanel({
  connId,
  stream,
  consumer,
}: {
  connId: string;
  stream: string;
  consumer: string;
}) {
  const { data, error, loading, refresh } = useConsumerDetail(
    connId,
    stream,
    consumer,
  );
  const cfg = data?.config ?? {};

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <ArrowDownToLine className="size-3.5 text-brand" />
        <span className="ml-1 truncate font-mono text-[11px] font-medium">
          {consumer}
        </span>
        <span className="ml-1 truncate text-[11px] text-muted-foreground">
          on {stream}
        </span>
        {data?.paused && (
          <span className="ml-1 inline-flex items-center gap-0.5 text-[11px] text-warn">
            <Pause className="size-3" /> paused
          </span>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh"
          title="Refresh"
          className="ml-auto"
          onClick={refresh}
        >
          <RefreshCw className={loading ? "animate-spin" : ""} />
        </Button>
      </div>

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
        <EmptyState icon={Loader2} className="flex-1 [&>svg]:animate-spin">
          Loading…
        </EmptyState>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3">
          <Section title="State">
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
