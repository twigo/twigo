import { create } from "zustand";
import {
  kvListBuckets,
  kvListKeys,
  type KvBucketSummary,
  type KvEntrySummary,
} from "@/lib/api";
import { useToasts } from "@/store/toasts";

type Status = "idle" | "loading" | "ready" | "error";

interface KvConnState {
  buckets: KvBucketSummary[];
  status: Status;
  error: string | null;
  expanded: Record<string, boolean>;
  keys: Record<string, KvEntrySummary[]>;
  keysLoading: Record<string, boolean>;
}

const EMPTY: KvConnState = {
  buckets: [],
  status: "idle",
  error: null,
  expanded: {},
  keys: {},
  keysLoading: {},
};

interface KvStore {
  byConn: Record<string, KvConnState>;
  load: (connId: string) => Promise<void>;
  toggleBucket: (connId: string, bucket: string) => Promise<void>;
  refreshKeys: (connId: string, bucket: string) => Promise<void>;
  collapseAll: (connId: string) => void;
  reset: (connId: string) => void;
}

export const useKv = create<KvStore>((set, get) => {
  const patch = (connId: string, fn: (s: KvConnState) => KvConnState) =>
    set((state) => ({
      byConn: { ...state.byConn, [connId]: fn(state.byConn[connId] ?? EMPTY) },
    }));

  return {
    byConn: {},

    load: async (connId) => {
      patch(connId, (s) => ({ ...s, status: "loading", error: null }));
      try {
        const buckets = await kvListBuckets(connId);
        patch(connId, (s) => ({ ...s, buckets, status: "ready" }));
      } catch (e) {
        patch(connId, (s) => ({ ...s, status: "error", error: String(e) }));
      }
    },

    toggleBucket: async (connId, bucket) => {
      const cur = get().byConn[connId] ?? EMPTY;
      const willExpand = !cur.expanded[bucket];
      patch(connId, (s) => ({
        ...s,
        expanded: { ...s.expanded, [bucket]: willExpand },
      }));
      if (willExpand && !get().byConn[connId]?.keys[bucket]) {
        await get().refreshKeys(connId, bucket);
      }
    },

    refreshKeys: async (connId, bucket) => {
      patch(connId, (s) => ({
        ...s,
        keysLoading: { ...s.keysLoading, [bucket]: true },
      }));
      try {
        const keys = await kvListKeys(connId, bucket);
        patch(connId, (s) => ({
          ...s,
          keys: { ...s.keys, [bucket]: keys },
          keysLoading: { ...s.keysLoading, [bucket]: false },
        }));
      } catch (e) {
        patch(connId, (s) => ({
          ...s,
          keysLoading: { ...s.keysLoading, [bucket]: false },
        }));
        useToasts
          .getState()
          .push("error", `Couldn't load keys for ${bucket}: ${String(e)}`);
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
