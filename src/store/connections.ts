import { create } from "zustand";
import { listContexts, type ContextSummary } from "@/lib/api";
import { useSettings } from "@/store/settings";

type LoadState = "idle" | "loading" | "ready" | "error";

interface ConnectionsState {
  contexts: ContextSummary[];
  status: LoadState;
  error: string | null;
  activeContext: string | null;
  load: () => Promise<void>;
  setActive: (name: string) => void;
}

export const useConnections = create<ConnectionsState>((set, get) => ({
  contexts: [],
  status: "idle",
  error: null,
  activeContext: null,
  load: async () => {
    set({ status: "loading", error: null });
    try {
      const dir = useSettings.getState().contextDir;
      const contexts = await listContexts(dir);
      const selected = contexts.find((c) => c.selected)?.name ?? null;
      set({
        contexts,
        status: "ready",
        activeContext: get().activeContext ?? selected,
      });
    } catch (e) {
      set({ status: "error", error: String(e) });
    }
  },
  setActive: (name) => set({ activeContext: name }),
}));
