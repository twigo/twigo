import { create, type UseBoundStore, type StoreApi } from "zustand";
import { useToasts } from "@/store/toasts";
import { registerConnScoped } from "@/store/connScoped";

// The shared shape behind every per-connection "lazy tree" browser (JetStream
// streams→consumers, KV buckets→keys, Object Store buckets→objects): a parent
// list loaded on demand, children fetched the first time a parent expands and
// cached after. A new domain gets the whole store - including conn-scoped
// teardown - by supplying two loaders and a noun.

export type Status = "idle" | "loading" | "ready" | "error";

export interface ConnTreeState<P, C> {
  parents: P[];
  status: Status;
  error: string | null;
  expanded: Record<string, boolean>;
  children: Record<string, C[]>;
  childrenLoading: Record<string, boolean>;
}

export interface ConnTreeStore<P, C> {
  byConn: Record<string, ConnTreeState<P, C>>;
  load: (connId: string) => Promise<void>;
  toggle: (connId: string, key: string) => Promise<void>;
  refreshChildren: (connId: string, key: string) => Promise<void>;
  collapseAll: (connId: string) => void;
  reset: (connId: string) => void;
}

interface ConnTreeConfig<P, C> {
  loadParents: (connId: string) => Promise<P[]>;
  loadChildren: (connId: string, key: string) => Promise<C[]>;
  // Noun for the child load-failure toast, e.g. "consumers" / "keys" / "objects".
  childNoun: string;
}

export function createConnTreeStore<P, C>(
  cfg: ConnTreeConfig<P, C>,
): UseBoundStore<StoreApi<ConnTreeStore<P, C>>> {
  const EMPTY: ConnTreeState<P, C> = {
    parents: [],
    status: "idle",
    error: null,
    expanded: {},
    children: {},
    childrenLoading: {},
  };

  // Per-conn generation, bumped on reset(). An async load captures the epoch
  // before awaiting and drops its write-back if reset() ran meanwhile - so a
  // disconnect mid-load can't resurrect a ghost entry for a dead connection.
  const epochs = new Map<string, number>();
  const epochOf = (connId: string) => epochs.get(connId) ?? 0;

  const store = create<ConnTreeStore<P, C>>((set, get) => {
    const patch = (
      connId: string,
      fn: (s: ConnTreeState<P, C>) => ConnTreeState<P, C>,
    ) =>
      set((state) => ({
        byConn: {
          ...state.byConn,
          [connId]: fn(state.byConn[connId] ?? EMPTY),
        },
      }));

    return {
      byConn: {},

      load: async (connId) => {
        patch(connId, (s) => ({ ...s, status: "loading", error: null }));
        const epoch = epochOf(connId);
        try {
          const parents = await cfg.loadParents(connId);
          if (epochOf(connId) !== epoch) return; // reset() ran mid-load
          patch(connId, (s) => ({ ...s, parents, status: "ready" }));
        } catch (e) {
          if (epochOf(connId) !== epoch) return;
          patch(connId, (s) => ({ ...s, status: "error", error: String(e) }));
        }
      },

      toggle: async (connId, key) => {
        const cur = get().byConn[connId] ?? EMPTY;
        const willExpand = !cur.expanded[key];
        patch(connId, (s) => ({
          ...s,
          expanded: { ...s.expanded, [key]: willExpand },
        }));
        if (willExpand && !get().byConn[connId]?.children[key]) {
          await get().refreshChildren(connId, key);
        }
      },

      refreshChildren: async (connId, key) => {
        patch(connId, (s) => ({
          ...s,
          childrenLoading: { ...s.childrenLoading, [key]: true },
        }));
        const epoch = epochOf(connId);
        try {
          const children = await cfg.loadChildren(connId, key);
          if (epochOf(connId) !== epoch) return; // reset() ran mid-load
          patch(connId, (s) => ({
            ...s,
            children: { ...s.children, [key]: children },
            childrenLoading: { ...s.childrenLoading, [key]: false },
          }));
        } catch (e) {
          if (epochOf(connId) !== epoch) return;
          patch(connId, (s) => ({
            ...s,
            childrenLoading: { ...s.childrenLoading, [key]: false },
          }));
          useToasts
            .getState()
            .push(
              "error",
              `Couldn't load ${cfg.childNoun} for ${key}: ${String(e)}`,
            );
        }
      },

      collapseAll: (connId) => patch(connId, (s) => ({ ...s, expanded: {} })),

      reset: (connId) => {
        epochs.set(connId, epochOf(connId) + 1); // invalidate in-flight loads
        set((state) => {
          const { [connId]: _drop, ...byConn } = state.byConn;
          return { byConn };
        });
      },
    };
  });

  // A conn-scoped tree always drops its state when the connection goes away.
  registerConnScoped(store);
  return store;
}
