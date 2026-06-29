import { describe, it, expect, beforeEach, vi } from "vitest";
import { encodeText } from "@twigo/utils";
import type { IncomingMessage, MessageBatch } from "@/lib/api";

const { subscribe, unsubscribe, publish } = vi.hoisted(() => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  publish: vi.fn(),
}));

vi.mock("@/lib/api", () => {
  class FakeChannel {
    onmessage: ((b: MessageBatch) => void) | null = null;
  }
  return { Channel: FakeChannel, subscribe, unsubscribe, publish };
});

const { render } = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("@/lib/template", () => ({
  render,
  buildMsgContext: (m: IncomingMessage) => m,
  warmUp: vi.fn(),
}));

import { useResponder } from "./responder";

function req(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    subject: "svc.get",
    reply: "_INBOX.1",
    payloadB64: encodeText("{}"),
    headers: [],
    size: 2,
    ...over,
  };
}

async function waitFor(pred: () => boolean, ms = 1000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timed out");
}

function deliver(msg: IncomingMessage) {
  const calls = subscribe.mock.calls;
  const channel = calls[calls.length - 1]?.[3] as {
    onmessage: ((b: MessageBatch) => void) | null;
  };
  channel.onmessage?.({ messages: [msg], dropped: 0 });
}

function sess(id = "r1", connId = "conn") {
  const s = useResponder.getState().byConn[connId]?.[id];
  if (!s) throw new Error(`no session ${connId}/${id}`);
  return s;
}

describe("responder store", () => {
  beforeEach(() => {
    useResponder.setState({ byConn: {} });
    subscribe.mockReset().mockResolvedValue(undefined);
    unsubscribe.mockReset().mockResolvedValue(undefined);
    publish.mockReset().mockResolvedValue(undefined);
    render.mockReset();
  });

  it("ensures a session with defaults", () => {
    useResponder.getState().ensure("r1", "conn", "svc.get");
    const s = sess();
    expect(s.config.subject).toBe("svc.get");
    expect(s.config.mode).toBe("reply");
    expect(s.listening).toBe(false);
  });

  it("auto-replies to a request with the rendered template", async () => {
    render.mockResolvedValue({ ok: true, output: "PONG" });
    useResponder.getState().ensure("r1", "conn", "svc.get");
    await useResponder.getState().start("conn", "r1");
    expect(subscribe).toHaveBeenCalledWith(
      "conn",
      "responder::r1",
      "svc.get",
      expect.anything(),
      null,
    );

    deliver(req());
    await waitFor(() => publish.mock.calls.length > 0);
    expect(publish).toHaveBeenCalledWith("conn", "_INBOX.1", "PONG", []);
    expect(sess().handled).toBe(1);
    // lastRequest is folded into the same write as the log entry.
    expect(sess().lastRequest?.subject).toBe("svc.get");
  });

  it("ignores messages without a reply subject", async () => {
    render.mockResolvedValue({ ok: true, output: "PONG" });
    useResponder.getState().ensure("r1", "conn", "svc.get");
    await useResponder.getState().start("conn", "r1");

    deliver(req({ reply: null }));
    await waitFor(() => sess().log.length > 0);
    expect(publish).not.toHaveBeenCalled();
    expect(sess().log[0]?.outcome).toMatchObject({ kind: "skipped" });
  });

  it("does not answer in down mode", async () => {
    render.mockResolvedValue({ ok: true, output: "PONG" });
    useResponder.getState().ensure("r1", "conn", "svc.get");
    useResponder.getState().setConfig("conn", "r1", { mode: "down" });
    await useResponder.getState().start("conn", "r1");

    deliver(req());
    await waitFor(() => sess().log.length > 0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("replies with service-error headers when the template fails", async () => {
    render.mockResolvedValue({ ok: false, error: "boom" });
    useResponder.getState().ensure("r1", "conn", "svc.get");
    await useResponder.getState().start("conn", "r1");

    deliver(req());
    await waitFor(() => publish.mock.calls.length > 0);
    // The wire reply carries a generic message; the detail stays in the log.
    expect(publish).toHaveBeenCalledWith("conn", "_INBOX.1", "", [
      ["Nats-Service-Error", "template render error"],
      ["Nats-Service-Error-Code", "500"],
    ]);
    await waitFor(() => sess().log.length > 0);
    expect(sess().log[0]?.outcome).toMatchObject({
      kind: "error",
      error: "boom",
    });
  });

  it("does not reply if stopped during the simulated delay", async () => {
    render.mockResolvedValue({ ok: true, output: "PONG" });
    useResponder.getState().ensure("r1", "conn", "svc.get");
    useResponder.getState().setConfig("conn", "r1", { delayMs: 50 });
    await useResponder.getState().start("conn", "r1");

    deliver(req());
    // Stop while the 50ms delay is still pending.
    await useResponder.getState().stop("conn", "r1");

    await waitFor(() => sess().log.length > 0);
    expect(publish).not.toHaveBeenCalled();
    expect(sess().log[0]?.outcome).toMatchObject({ kind: "skipped" });
  });

  it("stops listening and unsubscribes", async () => {
    render.mockResolvedValue({ ok: true, output: "PONG" });
    useResponder.getState().ensure("r1", "conn", "svc.get");
    await useResponder.getState().start("conn", "r1");
    await useResponder.getState().stop("conn", "r1");
    expect(unsubscribe).toHaveBeenCalledWith("responder::r1");
    expect(sess().listening).toBe(false);
  });

  it("keeps log ids unique across a stop/restart (no key collision)", async () => {
    render.mockResolvedValue({ ok: true, output: "PONG" });
    useResponder.getState().ensure("r1", "conn", "svc.get");

    await useResponder.getState().start("conn", "r1");
    deliver(req());
    await waitFor(() => sess().log.length === 1);
    const firstId = sess().log[0]?.id;

    await useResponder.getState().stop("conn", "r1");
    await useResponder.getState().start("conn", "r1");
    deliver(req());
    await waitFor(() => sess().log.length === 2);

    // The log isn't cleared on restart, so the new entry must get a fresh id.
    const ids = sess().log.map((e) => e.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain(undefined);
    expect(firstId).toBeDefined();
  });
});
