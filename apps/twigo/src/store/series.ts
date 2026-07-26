import { create } from "zustand";
import { registerConnScoped } from "@/store/connScoped";

export interface SeriesPoint {
  t: number;
  v: number;
}

// Rolling history of a polled number, so a detail panel grows a trend line
// without a store of its own. Never persisted - a chart restored from disk
// would span a window nothing sampled.
const RETENTION_MS = 30 * 60_000;
const MAX_POINTS = 720;

export const NO_POINTS: SeriesPoint[] = [];

interface SeriesState {
  byConn: Record<string, Record<string, SeriesPoint[]>>;
  push: (connId: string, key: string, v: number) => void;
  reset: (connId: string) => void;
}

export const useSeries = create<SeriesState>()((set) => ({
  byConn: {},

  push: (connId, key, v) =>
    set((state) => {
      const conn = state.byConn[connId] ?? {};
      const point = { t: Date.now(), v };
      const kept = (conn[key] ?? []).filter(
        (p) => p.t >= point.t - RETENTION_MS,
      );
      return {
        byConn: {
          ...state.byConn,
          [connId]: {
            ...conn,
            [key]: [...kept.slice(-(MAX_POINTS - 1)), point],
          },
        },
      };
    }),

  reset: (connId) =>
    set((state) => {
      if (!(connId in state.byConn)) return state;
      const { [connId]: _dropped, ...byConn } = state.byConn;
      return { byConn };
    }),
}));

registerConnScoped(useSeries);
