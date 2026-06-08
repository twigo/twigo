import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { IncomingMessage } from "@/lib/api";

const mocks = vi.hoisted(() => {
  const channels: { onmessage: (m: IncomingMessage) => void }[] = [];
  return {
    channels,
    subscribe: vi.fn(
      (
        _connId: string,
        _subId: string,
        _subject: string,
        ch: { onmessage: (m: IncomingMessage) => void },
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
    onmessage: (m: IncomingMessage) => void = () => {
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

    chA?.onmessage(msg("orders.new", "one"));
    chA?.onmessage(msg("orders.new", "two"));
    chB?.onmessage(msg("audit.login", "x"));

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
    chA?.onmessage(msg("orders.new", "blocked"));
    chB?.onmessage(msg("audit.login", "flows"));
    vi.advanceTimersByTime(150);

    expect(useStream.getState().sessions.a?.items).toHaveLength(0);
    expect(useStream.getState().sessions.b?.items).toHaveLength(1);
  });

  it("numbers message ids per session, not globally", async () => {
    await useStream.getState().open("a", "local", "orders.>");
    await useStream.getState().open("b", "local", "audit.>");
    const [chA, chB] = mocks.channels;

    chA?.onmessage(msg("orders.new", "x"));
    chB?.onmessage(msg("audit.login", "y"));
    chB?.onmessage(msg("audit.login", "z"));
    vi.advanceTimersByTime(150);

    expect(useStream.getState().sessions.a?.items[0]?.id).toBe(1);
    expect(useStream.getState().sessions.b?.items[0]?.id).toBe(1);
    expect(useStream.getState().sessions.b?.items[1]?.id).toBe(2);
  });

  it("clear empties items and resets follow", async () => {
    await useStream.getState().open("a", "local", "orders.>");
    const ch = mocks.channels[0];

    useStream.getState().setFollowing("a", false);
    ch?.onmessage(msg("orders.new", "x"));
    vi.advanceTimersByTime(150);
    expect(useStream.getState().sessions.a?.items).toHaveLength(1);

    useStream.getState().clear("a");
    expect(useStream.getState().sessions.a?.items).toHaveLength(0);
    expect(useStream.getState().sessions.a?.following).toBe(true);
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

    ch?.onmessage(msg("orders.new", "late"));
    vi.advanceTimersByTime(150);
    expect(useStream.getState().sessions.a).toBeUndefined();
  });
});
