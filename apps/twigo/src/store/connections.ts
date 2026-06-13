import { create } from "zustand";
import {
  listContexts,
  connect as apiConnect,
  disconnect as apiDisconnect,
  connInfo as apiConnInfo,
  ipcError,
  type ContextSummary,
  type ConnInfo,
} from "@/lib/api";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";
import { useResponder } from "@/store/responder";
import { resetConnScopedStores } from "@/store/connScoped";
import { useToasts } from "@/store/toasts";

type LoadState = "idle" | "loading" | "ready" | "error";

// Connections the user is intentionally closing - suppresses the "lost
// connection" toast for drop/lame-duck events that a deliberate disconnect
// emits on its way down. Transient, never persisted.
const closing = new Set<string>();

// A dropped link usually self-heals in well under a second; only a sustained
// outage deserves a toast. Wait this long before announcing a drop, and stay
// silent entirely if it recovers within the window (transparent reconnect).
const DROP_GRACE_MS = 3000;
// A repeating condition (slow consumer) re-fires for as long as it lasts; toast
// it at most once per this window.
const SLOW_COOLDOWN_MS = 30_000;

const dropTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Conns whose outage we actually announced - gates the matching "reconnected"
// toast so a self-healed blip stays silent both ways.
const announced = new Set<string>();
// Last error message toasted per conn: a fault that repeats on every reconnect
// attempt (e.g. an auth failure) then toasts once, not once per attempt.
const lastError = new Map<string, string>();
const slowConsumerAt = new Map<string, number>();

// Drop all transient per-conn toast bookkeeping (on recovery, close, or a
// deliberate disconnect) so the next outage starts from a clean slate.
function clearLinkWatch(conn: string) {
  const t = dropTimers.get(conn);
  if (t !== undefined) clearTimeout(t);
  dropTimers.delete(conn);
  announced.delete(conn);
  lastError.delete(conn);
  slowConsumerAt.delete(conn);
}

function teardown(conn: string) {
  // Every per-connection domain store (subjects, JetStream, KV, Object Store,
  // monitor) self-registers in connScoped, so a new domain joins teardown
  // without editing this file.
  resetConnScopedStores(conn);
  // The editor layer injects this (setEditorTeardown) so the store doesn't
  // depend on the UI - keeps the dependency one-way (editor → store).
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
  onEvent: (conn: string, kind: string, detail?: string | null) => void;
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
      const err = ipcError(e);
      // Branch on the typed kind for an actionable hint on the common failure.
      const hint =
        err.kind === "credentials" ? " - check the context's credentials" : "";
      set((s) => ({
        connecting: { ...s.connecting, [name]: false },
        connError: { ...s.connError, [name]: err.message },
      }));
      useToasts
        .getState()
        .push("error", `Couldn't connect to ${name}: ${err.message}${hint}`);
    }
  },

  disconnect: async (name) => {
    closing.add(name);
    clearLinkWatch(name);
    try {
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
    } finally {
      closing.delete(name);
    }
  },

  // The link state is driven by backend events, not the optimistic connect()
  // result (which can resolve while still background-reconnecting).
  onEvent: (conn, kind, detail) => {
    const toasts = useToasts.getState();
    if (kind === "connected") {
      // Cancel a pending drop announcement and, if we already told the user the
      // link was down, tell them it's back. A self-healed blip stays silent.
      const wasAnnounced = announced.has(conn);
      clearLinkWatch(conn);
      // Link is up: clear any backoff state and refresh real server info / rtt
      // (covers a pending connect and transparent mid-session reconnects).
      set((s) => {
        const { [conn]: _r, ...reconnecting } = s.reconnecting;
        return { reconnecting };
      });
      if (wasAnnounced) toasts.push("success", `Reconnected to ${conn}`);
      void apiConnInfo(conn).then((info) => {
        set((s) =>
          s.connected[conn]
            ? { connected: { ...s.connected, [conn]: info } }
            : s,
        );
      });
    } else if (kind === "disconnected") {
      const cur = get().connected[conn];
      if (cur) {
        set((s) => ({
          connected: { ...s.connected, [conn]: { ...cur, connected: false } },
        }));
      }
      // Defer the toast past the grace window: a quick auto-reconnect should be
      // invisible. Arm once per outage, skip repeats and user-led disconnects.
      const watch =
        cur?.connected === true &&
        !closing.has(conn) &&
        !dropTimers.has(conn) &&
        !announced.has(conn);
      if (watch) {
        const timer = setTimeout(() => {
          dropTimers.delete(conn);
          const down = get().connected[conn];
          if (down && !down.connected && !closing.has(conn)) {
            announced.add(conn);
            useToasts
              .getState()
              .push("warning", `Lost connection to ${conn} - reconnecting…`);
          }
        }, DROP_GRACE_MS);
        dropTimers.set(conn, timer);
      }
    } else if (kind === "closed") {
      clearLinkWatch(conn);
      teardown(conn);
      set((s) => {
        const { [conn]: _removed, ...connected } = s.connected;
        const { [conn]: _r, ...reconnecting } = s.reconnecting;
        return { connected, reconnecting };
      });
    } else if (kind === "lameDuck") {
      if (!closing.has(conn)) {
        toasts.push(
          "warning",
          `${conn} is entering lame-duck mode - server shutting down`,
        );
      }
    } else if (kind === "slowConsumer") {
      const last = slowConsumerAt.get(conn);
      if (
        !closing.has(conn) &&
        (last === undefined || Date.now() - last > SLOW_COOLDOWN_MS)
      ) {
        slowConsumerAt.set(conn, Date.now());
        toasts.push(
          "warning",
          `${conn}: slow consumer - messages may be dropped`,
        );
      }
    } else if (kind === "serverError" || kind === "clientError") {
      const fallback = kind === "serverError" ? "server error" : "client error";
      const msg = `${conn}: ${detail ?? fallback}`;
      // Dedupe: the same fault repeats on every reconnect attempt.
      if (lastError.get(conn) !== msg) {
        lastError.set(conn, msg);
        toasts.push("error", msg);
      }
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
