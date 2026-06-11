import { create } from "zustand";
import {
  objListBuckets,
  objListObjects,
  type ObjBucketSummary,
  type ObjSummary,
} from "@/lib/api";
import { useToasts } from "@/store/toasts";

type Status = "idle" | "loading" | "ready" | "error";

interface ObjConnState {
  buckets: ObjBucketSummary[];
  status: Status;
  error: string | null;
  expanded: Record<string, boolean>;
  objects: Record<string, ObjSummary[]>;
  objectsLoading: Record<string, boolean>;
}

const EMPTY: ObjConnState = {
  buckets: [],
  status: "idle",
  error: null,
  expanded: {},
  objects: {},
  objectsLoading: {},
};

interface ObjStore {
  byConn: Record<string, ObjConnState>;
  load: (connId: string) => Promise<void>;
  toggleBucket: (connId: string, bucket: string) => Promise<void>;
  refreshObjects: (connId: string, bucket: string) => Promise<void>;
  collapseAll: (connId: string) => void;
  reset: (connId: string) => void;
}

export const useObjStore = create<ObjStore>((set, get) => {
  const patch = (connId: string, fn: (s: ObjConnState) => ObjConnState) =>
    set((state) => ({
      byConn: { ...state.byConn, [connId]: fn(state.byConn[connId] ?? EMPTY) },
    }));

  return {
    byConn: {},

    load: async (connId) => {
      patch(connId, (s) => ({ ...s, status: "loading", error: null }));
      try {
        const buckets = await objListBuckets(connId);
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
      if (willExpand && !get().byConn[connId]?.objects[bucket]) {
        await get().refreshObjects(connId, bucket);
      }
    },

    refreshObjects: async (connId, bucket) => {
      patch(connId, (s) => ({
        ...s,
        objectsLoading: { ...s.objectsLoading, [bucket]: true },
      }));
      try {
        const objects = await objListObjects(connId, bucket);
        patch(connId, (s) => ({
          ...s,
          objects: { ...s.objects, [bucket]: objects },
          objectsLoading: { ...s.objectsLoading, [bucket]: false },
        }));
      } catch (e) {
        patch(connId, (s) => ({
          ...s,
          objectsLoading: { ...s.objectsLoading, [bucket]: false },
        }));
        useToasts
          .getState()
          .push("error", `Couldn't load objects for ${bucket}: ${String(e)}`);
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
