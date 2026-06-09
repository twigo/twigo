import { create } from "zustand";
import {
  Channel,
  subscribe as apiSubscribe,
  unsubscribe as apiUnsubscribe,
  publish as apiPublish,
  type IncomingMessage,
} from "@/lib/api";
import { decodePreview } from "@twigo/utils";
import { render, buildMsgContext, warmUp } from "@/lib/template";

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
  seq: number;
}

const runtimes = new Map<string, Runtime>();

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

interface ResponderState {
  sessions: Record<string, ResponderSession>;
  ensure: (id: string, connId: string, subject: string) => void;
  setConfig: (id: string, patch: Partial<ResponderConfig>) => void;
  start: (id: string) => Promise<void>;
  stop: (id: string) => Promise<void>;
  remove: (id: string) => void;
  clearLog: (id: string) => void;
}

function patch(id: string, fn: (s: ResponderSession) => ResponderSession) {
  useResponder.setState((state) => {
    const cur = state.sessions[id];
    if (!cur) return state;
    return { sessions: { ...state.sessions, [id]: fn(cur) } };
  });
}

function omit<T>(obj: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
}

function appendLog(id: string, entry: ResponderLog) {
  patch(id, (s) => ({
    ...s,
    handled: s.handled + 1,
    log: [entry, ...s.log].slice(0, LOG_CAP),
  }));
}

async function handleMessage(id: string, m: IncomingMessage) {
  const session = useResponder.getState().sessions[id];
  const rt = runtimes.get(id);
  if (!session || !session.listening || !rt) return;

  rt.seq += 1;
  const entryId = rt.seq;
  const cfg = session.config;
  patch(id, (s) => ({ ...s, lastRequest: m }));
  const base: Omit<ResponderLog, "outcome" | "ms"> = {
    id: entryId,
    receivedAt: Date.now(),
    requestSubject: m.subject,
    requestPreview: decodePreview(m.payloadB64),
  };

  if (!m.reply) {
    appendLog(id, {
      ...base,
      outcome: { kind: "skipped", reason: "no reply subject" },
      ms: 0,
    });
    return;
  }
  if (cfg.mode === "down") {
    appendLog(id, {
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
      await apiPublish(session.connId, m.reply, "", [
        [ERROR_HEADER, rendered.error.slice(0, 200)],
        [ERROR_CODE_HEADER, "500"],
      ]);
    } catch {
      /* connection gone; the local log still records the failure */
    }
    appendLog(id, {
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
      session.connId,
      m.reply,
      rendered.output,
      headers as [string, string][],
    );
    appendLog(id, {
      ...base,
      outcome: { kind: "sent", output: rendered.output },
      ms,
    });
  } catch (e) {
    appendLog(id, {
      ...base,
      outcome: { kind: "error", error: String(e) },
      ms,
    });
  }
}

export const useResponder = create<ResponderState>((set, get) => ({
  sessions: {},

  ensure: (id, connId, subject) => {
    if (get().sessions[id]) return;
    set((state) => ({
      sessions: {
        ...state.sessions,
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
    }));
  },

  setConfig: (id, p) =>
    patch(id, (s) => ({ ...s, config: { ...s.config, ...p } })),

  start: async (id) => {
    const session = get().sessions[id];
    if (!session || session.listening) return;
    const subject = session.config.subject.trim();
    if (!subject) return;

    warmUp();
    const subId = `responder::${id}`;
    const channel = new Channel<IncomingMessage>();
    channel.onmessage = (m) => {
      void handleMessage(id, m);
    };
    runtimes.set(id, { channel, seq: 0 });
    patch(id, (s) => ({ ...s, subId, listening: true }));

    try {
      await apiSubscribe(session.connId, subId, subject, channel);
    } catch (e) {
      runtimes.delete(id);
      patch(id, (s) => ({ ...s, subId: null, listening: false }));
      throw e;
    }
  },

  stop: async (id) => {
    const session = get().sessions[id];
    runtimes.delete(id);
    patch(id, (s) => ({ ...s, listening: false, subId: null }));
    if (session?.subId) {
      try {
        await apiUnsubscribe(session.subId);
      } catch {
        /* already gone if the connection dropped */
      }
    }
  },

  remove: (id) => {
    const session = get().sessions[id];
    runtimes.delete(id);
    if (session?.subId)
      void apiUnsubscribe(session.subId).catch(() => undefined);
    set((state) => ({ sessions: omit(state.sessions, id) }));
  },

  clearLog: (id) => patch(id, (s) => ({ ...s, log: [], handled: 0 })),
}));
