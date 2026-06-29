import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  Channel,
  subscribe as apiSubscribe,
  unsubscribe as apiUnsubscribe,
  publish as apiPublish,
  type IncomingMessage,
} from "@/lib/api";
import { decodePreview } from "@twigo/utils";
import { render, buildMsgContext, warmUp } from "@/lib/template";
import { createPersistStorage } from "@/lib/persist-storage";

const LOG_CAP = 200;

export type ResponderMode = "reply" | "error" | "down";

export interface ResponderConfig {
  subject: string;
  template: string;
  headers: [string, string][];
  delayMs: number;
  mode: ResponderMode;
}

export type ReplyOutcome =
  | { kind: "sent"; output: string }
  | { kind: "error"; error: string }
  | { kind: "skipped"; reason: string };

export interface ResponderLog {
  id: number;
  receivedAt: number;
  requestSubject: string;
  requestPreview: string;
  outcome: ReplyOutcome;
  ms: number;
}

export interface ResponderSession {
  id: string;
  connId: string;
  subId: string | null;
  config: ResponderConfig;
  listening: boolean;
  handled: number;
  log: ResponderLog[];
  lastRequest: IncomingMessage | null;
}

interface Runtime {
  channel: Channel<IncomingMessage>;
}

const runtimes = new Map<string, Runtime>();

// Session-global, monotonic log-entry id. A per-runtime counter resets to 0 on
// each start(), which (with the log not cleared) made new ids collide with old
// ones and duplicated React keys after stop -> start.
let nextLogId = 0;

const DEFAULT_TEMPLATE = `{
  "ok": true,
  "received": "{{ $msg.subject }}",
  "id": "{{ $uuid() }}",
  "at": "{{ $now }}"
}`;

function defaultConfig(subject: string): ResponderConfig {
  return {
    subject,
    template: DEFAULT_TEMPLATE,
    headers: [],
    delayMs: 0,
    mode: "reply",
  };
}

const ERROR_HEADER = "Nats-Service-Error";
const ERROR_CODE_HEADER = "Nats-Service-Error-Code";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function omitKey<T>(obj: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = obj;
  return rest;
}

interface ResponderState {
  byConn: Record<string, Record<string, ResponderSession>>;
  ensure: (id: string, connId: string, subject: string) => void;
  setConfig: (
    connId: string,
    id: string,
    patch: Partial<ResponderConfig>,
  ) => void;
  start: (connId: string, id: string) => Promise<void>;
  stop: (connId: string, id: string) => Promise<void>;
  remove: (connId: string, id: string) => void;
  removeConn: (connId: string) => void;
  pruneConns: (names: string[]) => void;
  clearLog: (connId: string, id: string) => void;
}

function patch(
  connId: string,
  id: string,
  fn: (s: ResponderSession) => ResponderSession,
) {
  useResponder.setState((state) => {
    const conn = state.byConn[connId];
    const cur = conn?.[id];
    if (!conn || !cur) return state;
    return {
      byConn: { ...state.byConn, [connId]: { ...conn, [id]: fn(cur) } },
    };
  });
}

function appendLog(connId: string, id: string, entry: ResponderLog) {
  patch(connId, id, (s) => ({
    ...s,
    handled: s.handled + 1,
    log: [entry, ...s.log].slice(0, LOG_CAP),
  }));
}

async function handleMessage(connId: string, id: string, m: IncomingMessage) {
  const session = useResponder.getState().byConn[connId]?.[id];
  const rt = runtimes.get(id);
  if (!session || !session.listening || !rt) return;

  const entryId = ++nextLogId;
  const cfg = session.config;
  patch(connId, id, (s) => ({ ...s, lastRequest: m }));
  const base: Omit<ResponderLog, "outcome" | "ms"> = {
    id: entryId,
    receivedAt: Date.now(),
    requestSubject: m.subject,
    requestPreview: decodePreview(m.payloadB64),
  };

  if (!m.reply) {
    appendLog(connId, id, {
      ...base,
      outcome: { kind: "skipped", reason: "no reply subject" },
      ms: 0,
    });
    return;
  }
  if (cfg.mode === "down") {
    appendLog(connId, id, {
      ...base,
      outcome: { kind: "skipped", reason: "simulated no-responder" },
      ms: 0,
    });
    return;
  }

  const t0 = performance.now();
  const rendered = await render(cfg.template, buildMsgContext(m));
  if (cfg.delayMs > 0) await sleep(cfg.delayMs);
  const ms = Math.round(performance.now() - t0);

  if (!rendered.ok) {
    try {
      await apiPublish(connId, m.reply, "", [
        [ERROR_HEADER, rendered.error.slice(0, 200)],
        [ERROR_CODE_HEADER, "500"],
      ]);
    } catch {
      /* connection gone; the local log still records the failure */
    }
    appendLog(connId, id, {
      ...base,
      outcome: { kind: "error", error: rendered.error },
      ms,
    });
    return;
  }

  const headers =
    cfg.mode === "error"
      ? [
          ...cfg.headers,
          [ERROR_HEADER, rendered.output.slice(0, 200)],
          [ERROR_CODE_HEADER, "500"],
        ]
      : cfg.headers;
  try {
    await apiPublish(
      connId,
      m.reply,
      rendered.output,
      headers as [string, string][],
    );
    appendLog(connId, id, {
      ...base,
      outcome: { kind: "sent", output: rendered.output },
      ms,
    });
  } catch (e) {
    appendLog(connId, id, {
      ...base,
      outcome: { kind: "error", error: String(e) },
      ms,
    });
  }
}

export const useResponder = create<ResponderState>()(
  persist(
    (set, get) => ({
      byConn: {},

      ensure: (id, connId, subject) => {
        if (get().byConn[connId]?.[id]) return;
        set((state) => ({
          byConn: {
            ...state.byConn,
            [connId]: {
              ...(state.byConn[connId] ?? {}),
              [id]: {
                id,
                connId,
                subId: null,
                config: defaultConfig(subject),
                listening: false,
                handled: 0,
                log: [],
                lastRequest: null,
              },
            },
          },
        }));
      },

      setConfig: (connId, id, p) =>
        patch(connId, id, (s) => ({ ...s, config: { ...s.config, ...p } })),

      start: async (connId, id) => {
        const session = get().byConn[connId]?.[id];
        if (!session || session.listening) return;
        const subject = session.config.subject.trim();
        if (!subject) return;

        warmUp();
        const subId = `responder::${id}`;
        const channel = new Channel<IncomingMessage>();
        channel.onmessage = (m) => {
          void handleMessage(connId, id, m);
        };
        runtimes.set(id, { channel });
        patch(connId, id, (s) => ({ ...s, subId, listening: true }));

        try {
          await apiSubscribe(connId, subId, subject, channel);
        } catch (e) {
          runtimes.delete(id);
          patch(connId, id, (s) => ({ ...s, subId: null, listening: false }));
          throw e;
        }
      },

      stop: async (connId, id) => {
        const session = get().byConn[connId]?.[id];
        runtimes.delete(id);
        patch(connId, id, (s) => ({ ...s, listening: false, subId: null }));
        if (session?.subId) {
          try {
            await apiUnsubscribe(session.subId);
          } catch {
            /* already gone if the connection dropped */
          }
        }
      },

      remove: (connId, id) => {
        const session = get().byConn[connId]?.[id];
        runtimes.delete(id);
        if (session?.subId)
          void apiUnsubscribe(session.subId).catch(() => undefined);
        set((state) => {
          const conn = state.byConn[connId];
          if (!conn) return state;
          const next = omitKey(conn, id);
          return {
            byConn:
              Object.keys(next).length > 0
                ? { ...state.byConn, [connId]: next }
                : omitKey(state.byConn, connId),
          };
        });
      },

      removeConn: (connId) => {
        const conn = get().byConn[connId];
        if (!conn) return;
        for (const s of Object.values(conn)) {
          runtimes.delete(s.id);
          if (s.subId) void apiUnsubscribe(s.subId).catch(() => undefined);
        }
        set((state) => ({ byConn: omitKey(state.byConn, connId) }));
      },

      pruneConns: (names) => {
        const keep = new Set(names);
        for (const [connId, sessions] of Object.entries(get().byConn)) {
          if (!keep.has(connId))
            for (const id of Object.keys(sessions)) runtimes.delete(id);
        }
        set((state) => ({
          byConn: Object.fromEntries(
            Object.entries(state.byConn).filter(([k]) => keep.has(k)),
          ),
        }));
      },

      clearLog: (connId, id) =>
        patch(connId, id, (s) => ({ ...s, log: [], handled: 0 })),
    }),
    {
      name: "twigo-responders",
      version: 1,
      storage: createPersistStorage(),
      // Persist config only; live runtime is rebuilt at launch (stopped).
      partialize: (state) => ({
        byConn: Object.fromEntries(
          Object.entries(state.byConn).map(([connId, sessions]) => [
            connId,
            Object.fromEntries(
              Object.entries(sessions).map(([id, s]) => [
                id,
                {
                  id: s.id,
                  connId: s.connId,
                  subId: null,
                  config: s.config,
                  listening: false,
                  handled: 0,
                  log: [],
                  lastRequest: null,
                },
              ]),
            ),
          ]),
        ),
      }),
    },
  ),
);
