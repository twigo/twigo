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
import { useResponder } from "@/store/responder";
import { useJetStream } from "@/store/jetstream";
import { useKv } from "@/store/kv";
import { useObjStore } from "@/store/objstore";
import { useMonitor } from "@/store/monitor";
import { useToasts } from "@/store/toasts";

type LoadState = "idle" | "loading" | "ready" | "error";

function teardown(conn: string) {
  useSubjects.getState().reset(conn);
  useJetStream.getState().reset(conn);
  useKv.getState().reset(conn);
  useObjStore.getState().reset(conn);
  useMonitor.getState().reset(conn);
  // The editor layer injects this (setEditorTeardown) so the store doesn't
  // depend on the UI — keeps the dependency one-way (editor → store).
  useConnections.getState().editorTeardown(conn);
}

interface ConnectionsState {
  contexts: ContextSummary[];
  status: LoadState;
  error: string | null;
  activeContext: string | null;
  connected: Record<string, ConnInfo>;
  connecting: Record<string, boolean>;
  connError: Record<string, string>;
  // While a connection is dropped, the live backoff state for its next retry.
  reconnecting: Record<
    string,
    { attempt: number; delayMs: number; at: number }
  >;
  load: () => Promise<void>;
  setActive: (name: string) => void;
  connect: (name: string) => Promise<void>;
  disconnect: (name: string) => Promise<void>;
  onEvent: (conn: string, kind: string) => void;
  onReconnect: (conn: string, attempt: number, delayMs: number) => void;
  editorTeardown: (conn: string) => void;
  setEditorTeardown: (fn: (conn: string) => void) => void;
}

export const useConnections = create<ConnectionsState>((set, get) => ({
  contexts: [],
  status: "idle",
  error: null,
  activeContext: null,
  connected: {},
  connecting: {},
  connError: {},
  reconnecting: {},
  editorTeardown: () => undefined,
  setEditorTeardown: (fn) => set({ editorTeardown: fn }),

  load: async () => {
    set({ status: "loading", error: null });
    try {
      const dir = useSettings.getState().contextDir;
      const contexts = await listContexts(dir);
      // Drop persisted state for contexts that no longer exist (renamed/deleted
      // in the nats CLI) before restoring, so it can't orphan or ghost-reconnect.
      const names = contexts.map((c) => c.name);
      useWorkspace.getState().prune(names);
      useResponder.getState().pruneConns(names);

      const selected = contexts.find((c) => c.selected)?.name ?? null;
      const remembered = useWorkspace.getState().activeContext;
      const restored =
        remembered && names.includes(remembered) ? remembered : null;
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
      useToasts
        .getState()
        .push("error", `Couldn't connect to ${name}: ${String(e)}`);
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
      const { [name]: _r, ...reconnecting } = s.reconnecting;
      return { connected, reconnecting };
    });
  },

  // The link state is driven by backend events, not the optimistic connect()
  // result (which can resolve while still background-reconnecting).
  onEvent: (conn, kind) => {
    if (kind === "connected") {
      // Link is up: clear any backoff state and refresh real server info / rtt
      // (covers a pending connect and transparent mid-session reconnects).
      set((s) => {
        const { [conn]: _r, ...reconnecting } = s.reconnecting;
        return { reconnecting };
      });
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
        const { [conn]: _r, ...reconnecting } = s.reconnecting;
        return { connected, reconnecting };
      });
    } else if (kind === "slowConsumer") {
      useToasts
        .getState()
        .push("warning", `${conn}: slow consumer — messages may be dropped`);
    }
  },

  onReconnect: (conn, attempt, delayMs) =>
    set((s) => ({
      reconnecting: {
        ...s.reconnecting,
        [conn]: { attempt, delayMs, at: Date.now() },
      },
    })),
}));
