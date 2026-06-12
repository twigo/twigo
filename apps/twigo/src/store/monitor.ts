import { create } from "zustand";
import {
  monitorVarz,
  monitorJsz,
  monitorHealthz,
  type Varz,
  type Jsz,
  type Healthz,
} from "@/lib/api";

type Status = "idle" | "loading" | "ready" | "error" | "unavailable";

// One ring-buffer sample per poll — feeds rates (deltas of cumulative counters)
// and sparklines without re-querying.
export interface Sample {
  t: number;
  inMsgs: number;
  outMsgs: number;
  inBytes: number;
  outBytes: number;
  connections: number;
  slowConsumers: number;
  mem: number;
}

interface MonitorConnState {
  status: Status;
  error: string | null;
  varz: Varz | null;
  jsz: Jsz | null;
  healthz: Healthz | null;
  samples: Sample[];
}

const EMPTY: MonitorConnState = {
  status: "idle",
  error: null,
  varz: null,
  jsz: null,
  healthz: null,
  samples: [],
};

const MAX_SAMPLES = 90;

interface MonitorStore {
  byConn: Record<string, MonitorConnState>;
  poll: (connId: string) => Promise<void>;
  reset: (connId: string) => void;
}

export const useMonitor = create<MonitorStore>((set, get) => {
  const patch = (
    connId: string,
    fn: (s: MonitorConnState) => MonitorConnState,
  ) =>
    set((state) => ({
      byConn: { ...state.byConn, [connId]: fn(state.byConn[connId] ?? EMPTY) },
    }));

  return {
    byConn: {},

    poll: async (connId) => {
      const cur = get().byConn[connId] ?? EMPTY;
      // No $SYS access won't change without a reconnect (which resets); stop
      // hammering a connection that can't be monitored.
      if (cur.status === "unavailable") return;
      if (cur.status === "idle")
        patch(connId, (s) => ({ ...s, status: "loading" }));
      try {
        const varz = await monitorVarz(connId);
        const jsz = await monitorJsz(connId).catch(() => null);
        const healthz = await monitorHealthz(connId).catch(() => null);
        const sample: Sample = {
          t: Date.now(),
          inMsgs: varz.inMsgs,
          outMsgs: varz.outMsgs,
          inBytes: varz.inBytes,
          outBytes: varz.outBytes,
          connections: varz.connections,
          slowConsumers: varz.slowConsumers,
          mem: varz.mem,
        };
        patch(connId, (s) => ({
          ...s,
          status: "ready",
          error: null,
          varz,
          jsz,
          healthz,
          samples: [...s.samples, sample].slice(-MAX_SAMPLES),
        }));
      } catch (e) {
        const msg = String(e);
        // No $SYS responders = the connection isn't a system-account login.
        const unavailable = /system-account|\$SYS|no responders/i.test(msg);
        patch(connId, (s) => ({
          ...s,
          status: unavailable ? "unavailable" : "error",
          error: msg,
        }));
      }
    },

    reset: (connId) =>
      set((state) => {
        const { [connId]: _drop, ...byConn } = state.byConn;
        return { byConn };
      }),
  };
});

// Live msgs/s + bytes/s from the last two samples; null until there are two.
// Guards a counter reset (server restart) by treating cur<prev as no rate.
export function rates(samples: Sample[]): {
  msgsPerSec: number;
  bytesPerSec: number;
} | null {
  if (samples.length < 2) return null;
  const prev = samples[samples.length - 2];
  const cur = samples[samples.length - 1];
  if (!prev || !cur) return null;
  const dt = (cur.t - prev.t) / 1000;
  if (dt <= 0) return null;
  const dMsgs = cur.inMsgs + cur.outMsgs - (prev.inMsgs + prev.outMsgs);
  const dBytes = cur.inBytes + cur.outBytes - (prev.inBytes + prev.outBytes);
  if (dMsgs < 0 || dBytes < 0) return null;
  return { msgsPerSec: dMsgs / dt, bytesPerSec: dBytes / dt };
}
