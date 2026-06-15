import { describe, it, expect, beforeEach, vi } from "vitest";
import { encodeText } from "@twigo/utils";
import type { IncomingMessage } from "@/lib/api";

const { subscribe, unsubscribe, publish } = vi.hoisted(() => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  publish: vi.fn(),
}));

vi.mock("@/lib/api", () => {
  class FakeChannel {
    onmessage: ((m: IncomingMessage) => void) | null = null;
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
    onmessage: ((m: IncomingMessage) => void) | null;
  };
  channel.onmessage?.(msg);
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
    );

    deliver(req());
    await waitFor(() => publish.mock.calls.length > 0);
    expect(publish).toHaveBeenCalledWith("conn", "_INBOX.1", "PONG", []);
    expect(sess().handled).toBe(1);
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
    expect(publish).toHaveBeenCalledWith("conn", "_INBOX.1", "", [
      ["Nats-Service-Error", "boom"],
      ["Nats-Service-Error-Code", "500"],
    ]);
  });

  it("stops listening and unsubscribes", async () => {
    render.mockResolvedValue({ ok: true, output: "PONG" });
    useResponder.getState().ensure("r1", "conn", "svc.get");
    await useResponder.getState().start("conn", "r1");
    await useResponder.getState().stop("conn", "r1");
    expect(unsubscribe).toHaveBeenCalledWith("responder::r1");
    expect(sess().listening).toBe(false);
  });
});
