import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { IncomingMessage, MessageBatch } from "@/lib/api";

const mocks = vi.hoisted(() => {
  const channels: { onmessage: (b: MessageBatch) => void }[] = [];
  return {
    channels,
    subscribe: vi.fn(
      (
        _connId: string,
        _subId: string,
        _subject: string,
        ch: { onmessage: (b: MessageBatch) => void },
      ) => {
        mocks.channels.push(ch);
        return Promise.resolve();
      },
    ),
    unsubscribe: vi.fn(() => Promise.resolve()),
  };
});

vi.mock("@/lib/api", () => ({
  Channel: class {
    onmessage: (b: MessageBatch) => void = () => {
      /* set by store */
    };
  },
  subscribe: mocks.subscribe,
  unsubscribe: mocks.unsubscribe,
}));

import { useStream } from "./stream";

function msg(subject: string, text: string): IncomingMessage {
  return {
    subject,
    reply: null,
    payloadB64: btoa(text),
    headers: [],
    size: text.length,
  };
}

// Wrap messages in the backend's coalesced delivery envelope.
function batch(...messages: IncomingMessage[]): MessageBatch {
  return { messages, dropped: 0 };
}

describe("stream store (multi-session)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.channels.length = 0;
    mocks.subscribe.mockClear();
    mocks.unsubscribe.mockClear();
    useStream.setState({ sessions: {}, activeId: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens independent sessions and marks the last one active", async () => {
    await useStream.getState().open("a", "local", "orders.>");
    await useStream.getState().open("b", "local", "audit.>");

    const { sessions, activeId } = useStream.getState();
    expect(Object.keys(sessions)).toEqual(["a", "b"]);
    expect(activeId).toBe("b");
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
  });

  it("routes messages only to their own session and batches on flush", async () => {
    await useStream.getState().open("a", "local", "orders.>");
    await useStream.getState().open("b", "local", "audit.>");
    const [chA, chB] = mocks.channels;

    chA?.onmessage(batch(msg("orders.new", "one"), msg("orders.new", "two")));
    chB?.onmessage(batch(msg("audit.login", "x")));

    // Nothing is committed before the flush interval fires.
    expect(useStream.getState().sessions.a?.items).toHaveLength(0);
    vi.advanceTimersByTime(150);

    expect(useStream.getState().sessions.a?.items).toHaveLength(2);
    expect(useStream.getState().sessions.b?.items).toHaveLength(1);
    expect(useStream.getState().sessions.a?.items[0]?.preview).toContain("one");
  });

  it("pauses a single session without affecting others", async () => {
    await useStream.getState().open("a", "local", "orders.>");
    await useStream.getState().open("b", "local", "audit.>");
    const [chA, chB] = mocks.channels;

    useStream.getState().togglePause("a");
    chA?.onmessage(batch(msg("orders.new", "blocked")));
    chB?.onmessage(batch(msg("audit.login", "flows")));
    vi.advanceTimersByTime(150);

    expect(useStream.getState().sessions.a?.items).toHaveLength(0);
    expect(useStream.getState().sessions.b?.items).toHaveLength(1);
  });

  it("numbers message ids per session, not globally", async () => {
    await useStream.getState().open("a", "local", "orders.>");
    await useStream.getState().open("b", "local", "audit.>");
    const [chA, chB] = mocks.channels;

    chA?.onmessage(batch(msg("orders.new", "x")));
    chB?.onmessage(batch(msg("audit.login", "y"), msg("audit.login", "z")));
    vi.advanceTimersByTime(150);

    expect(useStream.getState().sessions.a?.items[0]?.id).toBe(1);
    expect(useStream.getState().sessions.b?.items[0]?.id).toBe(1);
    expect(useStream.getState().sessions.b?.items[1]?.id).toBe(2);
  });

  it("clear empties items and resets follow", async () => {
    await useStream.getState().open("a", "local", "orders.>");
    const ch = mocks.channels[0];

    useStream.getState().setFollowing("a", false);
    ch?.onmessage(batch(msg("orders.new", "x")));
    vi.advanceTimersByTime(150);
    expect(useStream.getState().sessions.a?.items).toHaveLength(1);

    useStream.getState().clear("a");
    expect(useStream.getState().sessions.a?.items).toHaveLength(0);
    expect(useStream.getState().sessions.a?.following).toBe(true);
  });

  it("counts every message received even past the display cap", async () => {
    await useStream.getState().open("a", "local", "orders.>");
    const ch = mocks.channels[0];

    const N = 2050; // CAP (retained window while following) is 2000
    for (let i = 0; i < N; i++)
      ch?.onmessage(batch(msg("orders.new", `m${i}`)));
    vi.advanceTimersByTime(150);

    const s = useStream.getState().sessions.a;
    expect(s?.items).toHaveLength(2000); // view is windowed
    expect(s?.received).toBe(N); // but the running total is honest
  });

  it("surfaces the dropped count from a coalesced batch", async () => {
    await useStream.getState().open("a", "local", "orders.>");
    const ch = mocks.channels[0];

    ch?.onmessage({ messages: [msg("orders.new", "x")], dropped: 5 });
    vi.advanceTimersByTime(150);

    const s = useStream.getState().sessions.a;
    expect(s?.items).toHaveLength(1);
    expect(s?.dropped).toBe(5);
  });

  it("keeps counting received while paused, without showing rows", async () => {
    await useStream.getState().open("a", "local", "orders.>");
    const ch = mocks.channels[0];

    useStream.getState().togglePause("a");
    ch?.onmessage(batch(msg("orders.new", "x"), msg("orders.new", "y")));
    vi.advanceTimersByTime(150);

    const s = useStream.getState().sessions.a;
    expect(s?.items).toHaveLength(0);
    expect(s?.received).toBe(2);
  });

  it("closes a session, unsubscribes and clears active when it was active", async () => {
    await useStream.getState().open("a", "local", "orders.>");
    await useStream.getState().open("b", "local", "audit.>");

    await useStream.getState().close("b");
    expect(useStream.getState().sessions.b).toBeUndefined();
    expect(useStream.getState().activeId).toBeNull();
    expect(useStream.getState().sessions.a).toBeDefined();
    expect(mocks.unsubscribe).toHaveBeenCalledWith("b::local::audit.>");
  });

  it("stops batching once a session is closed", async () => {
    await useStream.getState().open("a", "local", "orders.>");
    const ch = mocks.channels[0];
    await useStream.getState().close("a");

    ch?.onmessage(batch(msg("orders.new", "late")));
    vi.advanceTimersByTime(150);
    expect(useStream.getState().sessions.a).toBeUndefined();
  });
});
