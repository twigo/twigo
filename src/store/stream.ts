import { create } from "zustand";
import {
  Channel,
  subscribe as apiSubscribe,
  unsubscribe as apiUnsubscribe,
  type IncomingMessage,
} from "@/lib/api";
import { decodePreview, type StreamMessage } from "@/lib/message";

const CAP = 2000;
const FLUSH_MS = 100;

let channel: Channel<IncomingMessage> | null = null;
let buffer: StreamMessage[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let seq = 0;

interface StreamState {
  connId: string | null;
  subject: string | null;
  subId: string | null;
  items: StreamMessage[];
  paused: boolean;
  open: (connId: string, subject: string) => Promise<void>;
  close: () => Promise<void>;
  clear: () => void;
  togglePause: () => void;
}

function flush() {
  if (buffer.length === 0 || useStream.getState().paused) return;
  const batch = buffer;
  buffer = [];
  useStream.setState((s) => ({ items: [...s.items, ...batch].slice(-CAP) }));
}

export const useStream = create<StreamState>((set, get) => ({
  connId: null,
  subject: null,
  subId: null,
  items: [],
  paused: false,

  open: async (connId, subject) => {
    await get().close();
    const subId = `${connId}::${subject}`;
    const ch = new Channel<IncomingMessage>();
    ch.onmessage = (m) => {
      seq += 1;
      buffer.push({
        id: seq,
        receivedAt: Date.now(),
        subject: m.subject,
        reply: m.reply,
        payloadB64: m.payloadB64,
        headers: m.headers,
        size: m.size,
        preview: decodePreview(m.payloadB64),
      });
    };
    channel = ch;
    await apiSubscribe(connId, subId, subject, ch);
    flushTimer = setInterval(flush, FLUSH_MS);
    set({ connId, subject, subId, items: [], paused: false });
  },

  close: async () => {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    buffer = [];
    if (channel) channel = null;
    const { subId } = get();
    if (subId) await apiUnsubscribe(subId);
    set({ connId: null, subject: null, subId: null, items: [], paused: false });
  },

  clear: () => set({ items: [] }),
  togglePause: () => set((s) => ({ paused: !s.paused })),
}));
