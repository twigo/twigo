import { create } from "zustand";
import {
  jsListStreams,
  jsListConsumers,
  type StreamSummary,
  type ConsumerSummary,
} from "@/lib/api";
import { useToasts } from "@/store/toasts";

type Status = "idle" | "loading" | "ready" | "error";

interface JsConnState {
  streams: StreamSummary[];
  status: Status;
  error: string | null;
  expanded: Record<string, boolean>;
  consumers: Record<string, ConsumerSummary[]>;
  consumersLoading: Record<string, boolean>;
}

const EMPTY: JsConnState = {
  streams: [],
  status: "idle",
  error: null,
  expanded: {},
  consumers: {},
  consumersLoading: {},
};

interface JetStreamStore {
  byConn: Record<string, JsConnState>;
  load: (connId: string) => Promise<void>;
  toggleStream: (connId: string, stream: string) => Promise<void>;
  refreshConsumers: (connId: string, stream: string) => Promise<void>;
  collapseAll: (connId: string) => void;
  reset: (connId: string) => void;
}

export const useJetStream = create<JetStreamStore>((set, get) => {
  const patch = (connId: string, fn: (s: JsConnState) => JsConnState) =>
    set((state) => ({
      byConn: { ...state.byConn, [connId]: fn(state.byConn[connId] ?? EMPTY) },
    }));

  return {
    byConn: {},

    load: async (connId) => {
      patch(connId, (s) => ({ ...s, status: "loading", error: null }));
      try {
        const streams = await jsListStreams(connId);
        patch(connId, (s) => ({ ...s, streams, status: "ready" }));
      } catch (e) {
        patch(connId, (s) => ({ ...s, status: "error", error: String(e) }));
      }
    },

    toggleStream: async (connId, stream) => {
      const cur = get().byConn[connId] ?? EMPTY;
      const willExpand = !cur.expanded[stream];
      patch(connId, (s) => ({
        ...s,
        expanded: { ...s.expanded, [stream]: willExpand },
      }));
      if (willExpand && !get().byConn[connId]?.consumers[stream]) {
        await get().refreshConsumers(connId, stream);
      }
    },

    refreshConsumers: async (connId, stream) => {
      patch(connId, (s) => ({
        ...s,
        consumersLoading: { ...s.consumersLoading, [stream]: true },
      }));
      try {
        const consumers = await jsListConsumers(connId, stream);
        patch(connId, (s) => ({
          ...s,
          consumers: { ...s.consumers, [stream]: consumers },
          consumersLoading: { ...s.consumersLoading, [stream]: false },
        }));
      } catch (e) {
        patch(connId, (s) => ({
          ...s,
          consumersLoading: { ...s.consumersLoading, [stream]: false },
        }));
        useToasts
          .getState()
          .push("error", `Couldn't load consumers for ${stream}: ${String(e)}`);
      }
    },

    collapseAll: (connId) => patch(connId, (s) => ({ ...s, expanded: {} })),

    reset: (connId) =>
      set((state) => {
        const { [connId]: _drop, ...byConn } = state.byConn;
        return { byConn };
      }),
  };
});
