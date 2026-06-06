import { create } from "zustand";
import {
  listContexts,
  connect as apiConnect,
  disconnect as apiDisconnect,
  type ContextSummary,
  type ConnInfo,
} from "@/lib/api";
import { useSettings } from "@/store/settings";
import { useSubjects } from "@/store/subjects";
import { useStream } from "@/store/stream";

type LoadState = "idle" | "loading" | "ready" | "error";

function teardown(conn: string) {
  useSubjects.getState().reset(conn);
  if (useStream.getState().connId === conn) void useStream.getState().close();
}

interface ConnectionsState {
  contexts: ContextSummary[];
  status: LoadState;
  error: string | null;
  activeContext: string | null;
  connected: Record<string, ConnInfo>;
  connecting: Record<string, boolean>;
  connError: Record<string, string>;
  load: () => Promise<void>;
  setActive: (name: string) => void;
  connect: (name: string) => Promise<void>;
  disconnect: (name: string) => Promise<void>;
  onEvent: (conn: string, kind: string) => void;
}

export const useConnections = create<ConnectionsState>((set, get) => ({
  contexts: [],
  status: "idle",
  error: null,
  activeContext: null,
  connected: {},
  connecting: {},
  connError: {},

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

  connect: async (name) => {
    if (get().connecting[name]) return;
    set((s) => {
      const { [name]: _cleared, ...connError } = s.connError;
      return {
        connecting: { ...s.connecting, [name]: true },
        connError,
        activeContext: name,
      };
    });
    try {
      const dir = useSettings.getState().contextDir;
      const info = await apiConnect(name, dir);
      set((s) => ({
        connected: { ...s.connected, [name]: info },
        connecting: { ...s.connecting, [name]: false },
      }));
    } catch (e) {
      set((s) => ({
        connecting: { ...s.connecting, [name]: false },
        connError: { ...s.connError, [name]: String(e) },
      }));
    }
  },

  disconnect: async (name) => {
    await apiDisconnect(name);
    teardown(name);
    set((s) => {
      const { [name]: _removed, ...connected } = s.connected;
      return { connected };
    });
  },

  onEvent: (conn, kind) => {
    if (kind === "closed") {
      teardown(conn);
      set((s) => {
        const { [conn]: _removed, ...connected } = s.connected;
        return { connected };
      });
    }
  },
}));
