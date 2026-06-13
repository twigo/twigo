import { create } from "zustand";
import {
  Channel,
  subscribe as apiSubscribe,
  unsubscribe as apiUnsubscribe,
  type IncomingMessage,
} from "@/lib/api";
import { decodePreview, type StreamMessage } from "@twigo/utils";

const CAP = 2000;
const HARD_CAP = 50000;
const FLUSH_MS = 100;

export interface StreamSession {
  id: string;
  connId: string;
  subject: string;
  subId: string;
  items: StreamMessage[];
  paused: boolean;
  following: boolean;
  selectedId: number | null;
  // All-time messages received on this subscription. The live view only retains
  // a capped window (CAP while following), so this is how the user learns the
  // true volume - and that it keeps climbing while paused.
  received: number;
}

interface Runtime {
  channel: Channel<IncomingMessage>;
  buffer: StreamMessage[];
  timer: ReturnType<typeof setInterval>;
  seq: number;
}

// Per-session runtime kept outside the store: channels, batching buffers and
// flush timers are imperative and must not trigger React renders.
const runtimes = new Map<string, Runtime>();

interface StreamState {
  sessions: Record<string, StreamSession>;
  activeId: string | null;
  open: (id: string, connId: string, subject: string) => Promise<void>;
  close: (id: string) => Promise<void>;
  clear: (id: string) => void;
  togglePause: (id: string) => void;
  setFollowing: (id: string, following: boolean) => void;
  select: (id: string, msgId: number | null) => void;
  setActive: (id: string | null) => void;
}

function omit<T>(obj: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
}

function patch(id: string, fn: (s: StreamSession) => StreamSession) {
  useStream.setState((state) => {
    const cur = state.sessions[id];
    if (!cur) return state;
    return { sessions: { ...state.sessions, [id]: fn(cur) } };
  });
}

function flush(id: string) {
  const rt = runtimes.get(id);
  if (!rt || rt.buffer.length === 0) return;
  const session = useStream.getState().sessions[id];
  if (!session) return;
  if (session.paused) {
    // Paused streams keep receiving from the backend; bound the staging buffer
    // so a long pause on a busy subject can't grow memory without limit. Still
    // surface the running total so the user sees the stream is live upstream.
    if (rt.buffer.length > HARD_CAP) rt.buffer = rt.buffer.slice(-HARD_CAP);
    patch(id, (s) => ({ ...s, received: rt.seq }));
    return;
  }
  const batch = rt.buffer;
  rt.buffer = [];
  // Only trim from the top while following the tail; otherwise dropping old
  // rows would shift the scrolled-up view. Hard cap guards memory.
  const cap = session.following ? CAP : HARD_CAP;
  patch(id, (s) => ({
    ...s,
    items: [...s.items, ...batch].slice(-cap),
    received: rt.seq,
  }));
}

export const useStream = create<StreamState>((set, get) => ({
  sessions: {},
  activeId: null,

  open: async (id, connId, subject) => {
    const subId = `${id}::${connId}::${subject}`;
    const channel = new Channel<IncomingMessage>();
    channel.onmessage = (m) => {
      const rt = runtimes.get(id);
      if (!rt) return;
      rt.seq += 1;
      rt.buffer.push({
        id: rt.seq,
        receivedAt: Date.now(),
        subject: m.subject,
        reply: m.reply,
        payloadB64: m.payloadB64,
        headers: m.headers,
        size: m.size,
        preview: decodePreview(m.payloadB64),
      });
    };
    const timer = setInterval(() => {
      flush(id);
    }, FLUSH_MS);
    runtimes.set(id, { channel, buffer: [], timer, seq: 0 });
    set((state) => ({
      sessions: {
        ...state.sessions,
        [id]: {
          id,
          connId,
          subject,
          subId,
          items: [],
          paused: false,
          following: true,
          selectedId: null,
          received: 0,
        },
      },
      activeId: id,
    }));

    try {
      await apiSubscribe(connId, subId, subject, channel);
    } catch (e) {
      clearInterval(timer);
      runtimes.delete(id);
      set((state) => ({
        sessions: omit(state.sessions, id),
        activeId: state.activeId === id ? null : state.activeId,
      }));
      throw e;
    }
  },

  close: async (id) => {
    const rt = runtimes.get(id);
    if (rt) {
      clearInterval(rt.timer);
      runtimes.delete(id);
    }
    const session = get().sessions[id];
    set((state) => ({
      sessions: omit(state.sessions, id),
      activeId: state.activeId === id ? null : state.activeId,
    }));
    if (session) {
      try {
        await apiUnsubscribe(session.subId);
      } catch {
        // Best-effort: the subscription is already gone if the connection
        // dropped, and local teardown above already completed.
      }
    }
  },

  clear: (id) =>
    patch(id, (s) => ({
      ...s,
      items: [],
      selectedId: null,
      following: true,
    })),
  togglePause: (id) => patch(id, (s) => ({ ...s, paused: !s.paused })),
  setFollowing: (id, following) =>
    patch(id, (s) => ({
      ...s,
      following,
      items: following ? s.items.slice(-CAP) : s.items,
    })),
  select: (id, selectedId) => patch(id, (s) => ({ ...s, selectedId })),
  setActive: (activeId) => set({ activeId }),
}));
