import { create } from "zustand";
import { serviceStats, type ServiceStats } from "@/lib/api";
import { registerConnScoped } from "@/store/connScoped";

type Status = "idle" | "loading" | "ready" | "error";

interface ServicesConnState {
  status: Status;
  error: string | null;
  services: ServiceStats[];
}

const EMPTY: ServicesConnState = { status: "idle", error: null, services: [] };

interface ServicesStore {
  byConn: Record<string, ServicesConnState>;
  discover: (connId: string) => Promise<void>;
  reset: (connId: string) => void;
}

export const useServices = create<ServicesStore>((set) => {
  // Per-conn generation, bumped on reset(). A discover() captures the epoch
  // before awaiting and drops its write-back if reset() (disconnect) ran
  // meanwhile, so it can't resurrect a ghost entry for a dead connection.
  const epochs = new Map<string, number>();
  const epochOf = (connId: string) => epochs.get(connId) ?? 0;

  const patch = (
    connId: string,
    fn: (s: ServicesConnState) => ServicesConnState,
  ) =>
    set((state) => ({
      byConn: { ...state.byConn, [connId]: fn(state.byConn[connId] ?? EMPTY) },
    }));

  return {
    byConn: {},

    discover: async (connId) => {
      patch(connId, (s) => ({ ...s, status: "loading", error: null }));
      const epoch = epochOf(connId);
      try {
        const services = await serviceStats(connId);
        if (epochOf(connId) !== epoch) return;
        patch(connId, (s) => ({
          ...s,
          status: "ready",
          error: null,
          services,
        }));
      } catch (e) {
        if (epochOf(connId) !== epoch) return;
        patch(connId, (s) => ({ ...s, status: "error", error: String(e) }));
      }
    },

    reset: (connId) => {
      epochs.set(connId, epochOf(connId) + 1);
      set((state) => {
        const { [connId]: _drop, ...byConn } = state.byConn;
        return { byConn };
      });
    },
  };
});

registerConnScoped(useServices);
