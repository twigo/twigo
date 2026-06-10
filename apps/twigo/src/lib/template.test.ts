import { describe, it, expect } from "vitest";
import { render, scan, buildMsgContext, type MsgContext } from "./template";
import type { IncomingMessage } from "@/lib/api";

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

function msg(
  body: unknown,
  over: Partial<IncomingMessage> = {},
): IncomingMessage {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return {
    subject: "orders.get",
    reply: "_INBOX.123",
    payloadB64: b64(payload),
    headers: [],
    size: payload.length,
    ...over,
  };
}

function ctx(body: unknown, over: Partial<IncomingMessage> = {}): MsgContext {
  return buildMsgContext(msg(body, over));
}

async function out(template: string, c: MsgContext): Promise<string> {
  const r = await render(template, c);
  if (!r.ok) throw new Error(`render failed: ${r.error}`);
  return r.output;
}

describe("scan", () => {
  it("splits literals and expressions", () => {
    expect(scan("a {{ x }} b")).toEqual([
      { literal: "a " },
      { expr: "x" },
      { literal: " b" },
    ]);
  });

  it("returns a single literal when there are no expressions", () => {
    expect(scan("plain text")).toEqual([{ literal: "plain text" }]);
  });
});

describe("render", () => {
  it("resolves $msg.body field access", async () => {
    expect(await out("{{ $msg.body.name }}", ctx({ name: "Lana" }))).toBe(
      "Lana",
    );
  });

  it("resolves the $json alias of the body", async () => {
    expect(await out("{{ $json.name }}", ctx({ name: "Archer" }))).toBe(
      "Archer",
    );
  });

  it("concatenates literals and expressions", async () => {
    const r = await out('{"id":"{{ $json.id }}","ok":true}', ctx({ id: 42 }));
    expect(r).toBe('{"id":"42","ok":true}');
  });

  it("stringifies an object result as JSON", async () => {
    expect(await out("{{ $msg.body }}", ctx({ a: 1 }))).toBe('{"a":1}');
  });

  it("falls back to raw text for a non-JSON body", async () => {
    expect(await out("{{ $msg.body }}", ctx("hello"))).toBe("hello");
    expect(await out("{{ $msg.text }}", ctx("hello"))).toBe("hello");
  });

  it("exposes the request subject and headers", async () => {
    const c = ctx(
      {},
      { subject: "orders.99.get", headers: [["X-Trace", "abc"]] },
    );
    expect(await out("{{ $msg.subject }}", c)).toBe("orders.99.get");
    expect(await out('{{ $msg.headers["X-Trace"] }}', c)).toBe("abc");
  });

  it("evaluates full JavaScript (map, arrow fns, template literals)", async () => {
    const c = ctx({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    expect(await out("{{ $json.items.map(i => i.id).join('-') }}", c)).toBe(
      "1-2-3",
    );
    expect(await out("{{ `n=${$json.items.length}` }}", c)).toBe("n=3");
    expect(await out("{{ $json.items.length > 2 ? 'many' : 'few' }}", c)).toBe(
      "many",
    );
  });

  it("provides helper functions", async () => {
    expect(await out("{{ $if(true, 'a', 'b') }}", ctx({}))).toBe("a");
    expect(await out("{{ $ifEmpty($json.missing, 'def') }}", ctx({}))).toBe(
      "def",
    );
    expect(await out("{{ $uuid() }}", ctx({}))).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(await out("{{ $today }}", ctx({}))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("cannot reach host globals (sandboxed)", async () => {
    expect(await out("{{ typeof globalThis.fetch }}", ctx({}))).toBe(
      "undefined",
    );
    expect(await out("{{ typeof process }}", ctx({}))).toBe("undefined");
    expect(await out("{{ typeof require }}", ctx({}))).toBe("undefined");
  });

  it("surfaces an expression error instead of throwing", async () => {
    const r = await render("{{ $json.nope.deep }}", ctx({}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/deep|undefined|cannot/i);
  });

  it("caps oversized rendered output", async () => {
    const r = await render('{{ "x".repeat(2000000) }}', ctx({}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/exceeds/i);
  });

  it("interrupts a runaway expression via the deadline", async () => {
    const r = await render("{{ (() => { while (true) {} })() }}", ctx({}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/interrupt/i);
  }, 5000);
});
