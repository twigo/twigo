import { create } from "zustand";
import {
  listContexts,
  connect as apiConnect,
  disconnect as apiDisconnect,
  connInfo as apiConnInfo,
  type ContextSummary,
  type ConnInfo,
} from "@/lib/api";
import { useSettings } from "@/store/settings";
import { useSubjects } from "@/store/subjects";
import { useWorkspace } from "@/store/workspace";
import { closeEditorsForConn } from "@/lib/editor";

type LoadState = "idle" | "loading" | "ready" | "error";

function teardown(conn: string) {
  useSubjects.getState().reset(conn);
  closeEditorsForConn(conn);
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
      const remembered = useWorkspace.getState().activeContext;
      const restored =
        remembered && contexts.some((c) => c.name === remembered)
          ? remembered
          : null;
      set({
        contexts,
        status: "ready",
        activeContext: get().activeContext ?? restored ?? selected,
      });
    } catch (e) {
      set({ status: "error", error: String(e) });
    }
  },

  setActive: (name) => {
    set({ activeContext: name });
    useWorkspace.getState().setActiveContext(name);
  },

  connect: async (name) => {
    if (get().connecting[name]) return;
    set((s) => {
      const { [name]: _cleared, ...connError } = s.connError;
      return {
        connecting: { ...s.connecting, [name]: true },
        connError,
      };
    });
    try {
      const dir = useSettings.getState().contextDir;
      const info = await apiConnect(name, dir);
      set((s) => ({
        connected: { ...s.connected, [name]: info },
        connecting: { ...s.connecting, [name]: false },
      }));
      useWorkspace.getState().setConnected(name, true);
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
    // Explicit disconnect clears the restore intent (connection + its watch);
    // a dropped connection keeps them so the next launch/reconnect resumes.
    useWorkspace.getState().setConnected(name, false);
    useWorkspace.getState().setWatching(name, null);
    set((s) => {
      const { [name]: _removed, ...connected } = s.connected;
      return { connected };
    });
  },

  // The link state is driven by backend events, not the optimistic connect()
  // result (which can resolve while still background-reconnecting).
  onEvent: (conn, kind) => {
    if (kind === "connected") {
      // Link is up: refresh real server info / rtt (covers a connect that
      // resolved as pending, and transparent mid-session reconnects).
      void apiConnInfo(conn).then((info) => {
        set((s) =>
          s.connected[conn]
            ? { connected: { ...s.connected, [conn]: info } }
            : s,
        );
      });
    } else if (kind === "disconnected") {
      set((s) => {
        const cur = s.connected[conn];
        return cur
          ? {
              connected: {
                ...s.connected,
                [conn]: { ...cur, connected: false },
              },
            }
          : s;
      });
    } else if (kind === "closed") {
      teardown(conn);
      set((s) => {
        const { [conn]: _removed, ...connected } = s.connected;
        return { connected };
      });
    }
  },
}));
