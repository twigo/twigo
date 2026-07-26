import { create } from "zustand";
import {
  monitorVarz,
  monitorJsz,
  monitorHealthz,
  type Varz,
  type Jsz,
  type Healthz,
} from "@/lib/api";
import { registerConnScoped } from "@/store/connScoped";
import type { SeriesPoint } from "@/store/series";

export type { SeriesPoint };

type Status = "idle" | "loading" | "ready" | "error" | "unavailable";

// One ring-buffer sample per poll - feeds rates (deltas of cumulative counters)
// and sparklines without re-querying.
export interface Sample {
  t: number;
  inMsgs: number;
  outMsgs: number;
  inBytes: number;
  outBytes: number;
  connections: number;
  subscriptions: number;
  slowConsumers: number;
  mem: number;
  cpu: number;
}

interface MonitorConnState {
  status: Status;
  error: string | null;
  varz: Varz | null;
  jsz: Jsz | null;
  healthz: Healthz | null;
  samples: Sample[];
  unavailableAt: number | null;
}

const EMPTY: MonitorConnState = {
  status: "idle",
  error: null,
  varz: null,
  jsz: null,
  healthz: null,
  samples: [],
  unavailableAt: null,
};

// An hour of history, which is the longest window a chart offers. Bounded by
// count as well so a faster poll interval can't grow the buffer without limit.
const RETENTION_MS = 60 * 60_000;
const MAX_SAMPLES = 1_500;
// "unavailable" can be a transient timeout - back off, don't latch forever.
const UNAVAILABLE_RETRY_MS = 30_000;

function retain(samples: Sample[], next: Sample): Sample[] {
  const cutoff = next.t - RETENTION_MS;
  const kept = samples.filter((s) => s.t >= cutoff);
  return [...kept.slice(-(MAX_SAMPLES - 1)), next];
}

interface MonitorStore {
  byConn: Record<string, MonitorConnState>;
  poll: (
    connId: string,
    monitoringUrl: string | null,
    minIntervalMs?: number,
  ) => Promise<void>;
  reset: (connId: string) => void;
}

export const useMonitor = create<MonitorStore>((set, get) => {
  // Per-conn generation, bumped on reset(). A poll captures the epoch before
  // awaiting and drops its write-back if reset() (disconnect) ran meanwhile -
  // so a poll in flight at disconnect can't resurrect a ghost dead connection.
  const epochs = new Map<string, number>();
  const epochOf = (connId: string) => epochs.get(connId) ?? 0;

  const patch = (
    connId: string,
    fn: (s: MonitorConnState) => MonitorConnState,
  ) =>
    set((state) => ({
      byConn: { ...state.byConn, [connId]: fn(state.byConn[connId] ?? EMPTY) },
    }));

  return {
    byConn: {},

    poll: async (connId, monitoringUrl, minIntervalMs = 0) => {
      const cur = get().byConn[connId] ?? EMPTY;
      if (
        cur.status === "unavailable" &&
        Date.now() - (cur.unavailableAt ?? 0) < UNAVAILABLE_RETRY_MS
      ) {
        return;
      }
      // The view and the metrics tab share one series, so a second poller inside
      // the interval would double the request rate and skew the rates it feeds.
      const newest = cur.samples[cur.samples.length - 1];
      if (newest && Date.now() - newest.t < minIntervalMs) return;
      if (cur.status === "idle")
        patch(connId, (s) => ({ ...s, status: "loading" }));
      const epoch = epochOf(connId);
      try {
        const varz = await monitorVarz(connId, monitoringUrl);
        const jsz = await monitorJsz(connId, monitoringUrl).catch(() => null);
        const healthz = await monitorHealthz(connId, monitoringUrl).catch(
          () => null,
        );
        if (epochOf(connId) !== epoch) return; // reset() ran mid-poll
        const sample: Sample = {
          t: Date.now(),
          inMsgs: varz.inMsgs,
          outMsgs: varz.outMsgs,
          inBytes: varz.inBytes,
          outBytes: varz.outBytes,
          connections: varz.connections,
          subscriptions: varz.subscriptions,
          slowConsumers: varz.slowConsumers,
          mem: varz.mem,
          cpu: varz.cpu,
        };
        patch(connId, (s) => ({
          ...s,
          status: "ready",
          error: null,
          varz,
          jsz,
          healthz,
          samples: retain(s.samples, sample),
          unavailableAt: null,
        }));
      } catch (e) {
        if (epochOf(connId) !== epoch) return; // reset() ran mid-poll
        const msg = String(e);
        // No $SYS responders = the connection isn't a system-account login.
        const unavailable = /system-account|\$SYS|no responders/i.test(msg);
        patch(connId, (s) => ({
          ...s,
          status: unavailable ? "unavailable" : "error",
          error: msg,
          unavailableAt: unavailable ? Date.now() : null,
        }));
      }
    },

    reset: (connId) => {
      epochs.set(connId, epochOf(connId) + 1); // invalidate in-flight polls
      set((state) => {
        const { [connId]: _drop, ...byConn } = state.byConn;
        return { byConn };
      });
    },
  };
});

registerConnScoped(useMonitor);

// Per-second deltas of a cumulative counter, stamped at the later sample. A
// server restart resets the counters, so a negative delta yields no point.
export function rateSeries(
  samples: Sample[],
  pick: (s: Sample) => number,
): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    if (!prev || !cur) continue;
    const dt = (cur.t - prev.t) / 1000;
    const dv = pick(cur) - pick(prev);
    if (dt <= 0 || dv < 0) continue;
    out.push({ t: cur.t, v: dv / dt });
  }
  return out;
}

export function gaugeSeries(
  samples: Sample[],
  pick: (s: Sample) => number,
): SeriesPoint[] {
  return samples.map((s) => ({ t: s.t, v: pick(s) }));
}

export const TOTAL_MSGS = (s: Sample) => s.inMsgs + s.outMsgs;
export const TOTAL_BYTES = (s: Sample) => s.inBytes + s.outBytes;

// Live msgs/s + bytes/s from the last two samples; null until there are two.
export function rates(samples: Sample[]): {
  msgsPerSec: number;
  bytesPerSec: number;
} | null {
  const tail = samples.slice(-2);
  const msgs = rateSeries(tail, TOTAL_MSGS)[0];
  const bytes = rateSeries(tail, TOTAL_BYTES)[0];
  if (!msgs || !bytes) return null;
  return { msgsPerSec: msgs.v, bytesPerSec: bytes.v };
}
