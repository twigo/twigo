import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import {
  listContexts,
  connect as apiConnect,
  disconnect as apiDisconnect,
  connInfo as apiConnInfo,
  connRtt as apiConnRtt,
  deleteContext as apiDeleteContext,
  syncConnReadonly,
  ipcError,
  type ContextSummary,
  type ConnInfo,
} from "@/lib/api";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";
import { useResponder } from "@/store/responder";
import { useReadOnly } from "@/store/readonly";
import { useMonitorConfig } from "@/store/monitorConfig";
import { useCodecs } from "@/store/codecs";
import { useSpaces } from "@/store/spaces";
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

// ── RTT sampling ─────────────────────────────────────────────────────────
// One owner: started when a link comes up, stopped on every way a link dies.
// Both connect() and the "connected" event call start - the event can be missed
// during session restore (listeners register async), and connect() is absent on
// a mid-session reconnect - so start is idempotent to keep one probe per link.
const RTT_INTERVAL_MS = 10_000;
// A refused probe stays refused (e.g. no publish permission on _INBOX.>);
// give up for this link session instead of timing out every tick forever.
const RTT_FAILURE_LIMIT = 3;

const rttTimers = new Map<string, ReturnType<typeof setInterval>>();
// Bumped on every stop, so a probe that was in flight when the link cycled
// cannot write a stale sample into the next session.
const rttEpoch = new Map<string, number>();

function stopRttSampling(conn: string) {
  rttEpoch.set(conn, (rttEpoch.get(conn) ?? 0) + 1);
  const t = rttTimers.get(conn);
  if (t !== undefined) clearInterval(t);
  rttTimers.delete(conn);
  useConnections.setState((s) => {
    const { [conn]: _gone, ...rtt } = s.rtt;
    return { rtt };
  });
}

function startRttSampling(conn: string) {
  if (rttTimers.has(conn)) return;
  const epoch = rttEpoch.get(conn) ?? 0;
  let failures = 0;
  const sample = async () => {
    try {
      const ms = await apiConnRtt(conn);
      if (rttEpoch.get(conn) !== epoch) return;
      failures = 0;
      useConnections.setState((s) => {
        const prev = s.rtt[conn];
        // Light smoothing so the chip reads as a level, not a ticker.
        const next = prev === undefined ? ms : prev + 0.5 * (ms - prev);
        return { rtt: { ...s.rtt, [conn]: next } };
      });
    } catch (e) {
      if (rttEpoch.get(conn) !== epoch) return;
      failures += 1;
      useConnections.setState((s) => {
        const { [conn]: _gone, ...rtt } = s.rtt;
        return { rtt };
      });
      if (failures >= RTT_FAILURE_LIMIT) {
        console.error(
          `[rtt] ${conn}: giving up after ${String(failures)} failed probes`,
          e,
        );
        const t = rttTimers.get(conn);
        if (t !== undefined) clearInterval(t);
        rttTimers.delete(conn);
      }
    }
  };
  rttTimers.set(
    conn,
    setInterval(() => void sample(), RTT_INTERVAL_MS),
  );
  void sample();
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

export interface ConnectionsState {
  contexts: ContextSummary[];
  status: LoadState;
  error: string | null;
  activeContext: string | null;
  connected: Record<string, ConnInfo>;
  // A missing entry means "not measured"; any number would be a claim.
  rtt: Record<string, number>;
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
  removeContext: (name: string) => Promise<void>;
  onEvent: (conn: string, kind: string, detail?: string | null) => void;
  onReconnect: (conn: string, attempt: number, delayMs: number) => void;
  editorTeardown: (conn: string) => void;
  setEditorTeardown: (fn: (conn: string) => void) => void;
}

export const useConnections = create<ConnectionsState>()(
  subscribeWithSelector((set, get) => ({
    contexts: [],
    status: "idle",
    error: null,
    activeContext: null,
    connected: {},
    rtt: {},
    connecting: {},
    connError: {},
    reconnecting: {},
    editorTeardown: () => undefined,
    setEditorTeardown: (fn) => set({ editorTeardown: fn }),

    load: async () => {
      set({ status: "loading", error: null });
      try {
        const { contextDir, includeDemo } = useSettings.getState();
        const contexts = await listContexts(contextDir, includeDemo);
        // Drop persisted state for contexts that no longer exist (renamed/deleted
        // in the nats CLI) before restoring, so it can't orphan or ghost-reconnect.
        const names = contexts.map((c) => c.name);
        useWorkspace.getState().prune(names);
        useResponder.getState().pruneConns(names);
        useSpaces.getState().pruneTargets("nats", names);

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
        startRttSampling(name);
      } catch (e) {
        const err = ipcError(e);
        // Branch on the typed kind for an actionable hint on the common failure.
        const hint =
          err.kind === "credentials"
            ? " - check the context's credentials"
            : "";
        set((s) => ({
          connecting: { ...s.connecting, [name]: false },
          connError: { ...s.connError, [name]: err.message },
        }));
        useToasts
          .getState()
          .push("error", `Couldn't connect to ${name}: ${err.message}${hint}`, {
            key: `conn:${name}:err`,
          });
      }
    },

    disconnect: async (name) => {
      closing.add(name);
      clearLinkWatch(name);
      stopRttSampling(name);
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

    // Delete a context entirely. Deleting only the file would leave a live client
    // connected (messages keep arriving) and a stale active selection, so tear
    // the connection down first, then drop the file and re-resolve the selection.
    removeContext: async (name) => {
      if (get().connected[name]) {
        await get().disconnect(name);
      }
      useReadOnly.getState().setReadOnly(name, false);
      useMonitorConfig.getState().setUrl(name, null);
      useCodecs.getState().clearConn(name);
      const dir = useSettings.getState().contextDir;
      await apiDeleteContext(dir, name);
      if (get().activeContext === name) {
        set({ activeContext: null });
        useWorkspace.getState().setActiveContext(null);
      }
      await get().load();
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
        if (wasAnnounced)
          toasts.push("success", `Reconnected to ${conn}`, {
            key: `conn:${conn}:link`,
          });
        void apiConnInfo(conn).then((info) => {
          set((s) =>
            s.connected[conn]
              ? { connected: { ...s.connected, [conn]: info } }
              : s,
          );
        });
        startRttSampling(conn);
      } else if (kind === "disconnected") {
        stopRttSampling(conn);
        const cur = get().connected[conn];
        if (cur) {
          set((s) => ({
            connected: { ...s.connected, [conn]: { name: conn, server: null } },
          }));
        }
        // Defer the toast past the grace window: a quick auto-reconnect should be
        // invisible. Arm once per outage, skip repeats and user-led disconnects.
        const watch =
          !!cur?.server &&
          !closing.has(conn) &&
          !dropTimers.has(conn) &&
          !announced.has(conn);
        if (watch) {
          const timer = setTimeout(() => {
            dropTimers.delete(conn);
            const down = get().connected[conn];
            if (down && !down.server && !closing.has(conn)) {
              announced.add(conn);
              useToasts
                .getState()
                .push("warning", `Lost connection to ${conn} - reconnecting…`, {
                  key: `conn:${conn}:link`,
                });
            }
          }, DROP_GRACE_MS);
          dropTimers.set(conn, timer);
        }
      } else if (kind === "closed") {
        clearLinkWatch(conn);
        stopRttSampling(conn);
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
        const fallback =
          kind === "serverError" ? "server error" : "client error";
        const msg = `${conn}: ${detail ?? fallback}`;
        // Dedupe: the same fault repeats on every reconnect attempt.
        if (lastError.get(conn) !== msg) {
          lastError.set(conn, msg);
          toasts.push("error", msg, { key: `conn:${conn}:err` });
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
  })),
);

// Chained: full-set replaces must reach Rust in dispatch order.
let readonlySync = Promise.resolve();
useReadOnly.subscribe((s) => {
  const names = Object.keys(s.byConn);
  readonlySync = readonlySync.then(() =>
    syncConnReadonly(names).catch((e: unknown) => {
      useToasts
        .getState()
        .push("error", `Read-only sync failed: ${String(e)}`, {
          key: "readonly-sync",
        });
    }),
  );
});

// Derived questions the UI keeps asking, answered once. Every one of these was
// re-expressed in three or four components, which is how "has an entry" and
// "has a live link" drifted apart in the first place.
export const selectIsLive =
  (id: string | null | undefined) => (s: ConnectionsState) =>
    !!(id && s.connected[id]?.server);

export const selectHasJetStream =
  (id: string | null | undefined) => (s: ConnectionsState) =>
    !!(id && s.connected[id]?.server?.jetstream);

export const selectMaxPayload =
  (id: string, fallback: number) => (s: ConnectionsState) =>
    s.connected[id]?.server?.maxPayload ?? fallback;

export const selectServerVersion = (id: string) => (s: ConnectionsState) =>
  s.connected[id]?.server?.serverVersion ?? "";

export const selectLiveCount = (s: ConnectionsState) =>
  Object.values(s.connected).filter((i) => i.server).length;

export const selectAnyLive = (s: ConnectionsState) =>
  Object.values(s.connected).some((i) => i.server);

/** Name of a live connection: the active one if it qualifies, else any. */
export const selectFirstLive = (s: ConnectionsState): string | undefined => {
  const active = s.activeContext;
  if (active && s.connected[active]?.server) return active;
  return Object.values(s.connected).find((i) => i.server)?.name;
};
