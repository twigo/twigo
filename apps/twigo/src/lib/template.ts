import {
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
  type QuickJSWASMModule,
  type QuickJSContext,
} from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-browser-release-sync";
import { decodeText } from "@twigo/utils";
import type { IncomingMessage } from "@/lib/api";

const EVAL_TIMEOUT_MS = 1000;
const MEMORY_LIMIT = 16 * 1024 * 1024;
const STACK_LIMIT = 512 * 1024;
const MAX_OUTPUT = 1024 * 1024;

let modulePromise: Promise<QuickJSWASMModule> | null = null;
function loadModule(): Promise<QuickJSWASMModule> {
  modulePromise ??= newQuickJSWASMModuleFromVariant(variant);
  return modulePromise;
}

export function warmUp(): void {
  void loadModule();
}

export interface MsgContext {
  subject: string;
  reply: string | null;
  headers: Record<string, string>;
  size: number;
  body: unknown;
  text: string;
}

export function buildMsgContext(msg: IncomingMessage): MsgContext {
  const text = decodeText(msg.payloadB64);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of msg.headers) headers[k] = v;
  return {
    subject: msg.subject,
    reply: msg.reply,
    headers,
    size: msg.size,
    body,
    text,
  };
}

export type RenderResult =
  | { ok: true; output: string }
  | { ok: false; error: string };

type Segment = { literal: string } | { expr: string };

export function scan(template: string): Segment[] {
  const segments: Segment[] = [];
  const re = /\{\{([\s\S]*?)\}\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    if (m.index > last)
      segments.push({ literal: template.slice(last, m.index) });
    segments.push({ expr: (m[1] ?? "").trim() });
    last = m.index + m[0].length;
  }
  if (last < template.length) segments.push({ literal: template.slice(last) });
  return segments;
}

function stringify(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (typeof val === "string") return val;
  if (
    typeof val === "number" ||
    typeof val === "boolean" ||
    typeof val === "bigint"
  )
    return String(val);
  if (typeof val === "object") return JSON.stringify(val);
  return "";
}

function prepare(ctx: QuickJSContext, msg: MsgContext): void {
  ctx.runtime.setMemoryLimit(MEMORY_LIMIT);
  ctx.runtime.setMaxStackSize(STACK_LIMIT);
  ctx.runtime.setInterruptHandler(
    shouldInterruptAfterDeadline(Date.now() + EVAL_TIMEOUT_MS),
  );

  const data = JSON.stringify({
    $msg: {
      subject: msg.subject,
      reply: msg.reply,
      headers: msg.headers,
      size: msg.size,
      body: msg.body,
      text: msg.text,
    },
    $json: msg.body,
  });
  // Hand the bus data to the VM as a string value and JSON.parse it *inside*,
  // never concatenated into source - so payload bytes can't influence the code
  // (e.g. U+2028/U+2029, which JSON.stringify doesn't escape).
  const dataHandle = ctx.newString(data);
  ctx.setProp(ctx.global, "__twigo_data", dataHandle);
  dataHandle.dispose();

  const setup = `const __d=JSON.parse(globalThis.__twigo_data);
delete globalThis.__twigo_data;
globalThis.$msg=__d.$msg;
globalThis.$json=__d.$json;
globalThis.$now=new Date().toISOString();
globalThis.$today=$now.slice(0,10);
globalThis.$timestamp=Date.now();
globalThis.$if=function(c,a,b){return c?a:b};
globalThis.$ifEmpty=function(v,f){return v===undefined||v===null||v===""?f:v};`;
  const r = ctx.evalCode(setup);
  if (r.error) {
    const detail: unknown = ctx.dump(r.error);
    r.error.dispose();
    throw new Error(`setup failed: ${stringify(detail)}`);
  }
  r.value.dispose();

  const uuid = ctx.newFunction("$uuid", () =>
    ctx.newString(globalThis.crypto.randomUUID()),
  );
  ctx.setProp(ctx.global, "$uuid", uuid);
  uuid.dispose();
}

function evalExpr(ctx: QuickJSContext, expr: string): unknown {
  const res = ctx.evalCode(`(${expr})`);
  if (res.error) {
    const detail: unknown = ctx.dump(res.error);
    res.error.dispose();
    const message =
      detail && typeof detail === "object" && "message" in detail
        ? stringify(detail.message)
        : stringify(detail);
    throw new Error(message);
  }
  const val: unknown = ctx.dump(res.value);
  res.value.dispose();
  return val;
}

export async function render(
  template: string,
  msg: MsgContext,
): Promise<RenderResult> {
  const segments = scan(template);
  if (!segments.some((s) => "expr" in s)) return { ok: true, output: template };

  const mod = await loadModule();
  const ctx = mod.newContext();
  try {
    prepare(ctx, msg);
    let out = "";
    for (const seg of segments) {
      out +=
        "literal" in seg ? seg.literal : stringify(evalExpr(ctx, seg.expr));
      if (out.length > MAX_OUTPUT) {
        return {
          ok: false,
          error: `rendered output exceeds ${MAX_OUTPUT} bytes`,
        };
      }
    }
    return { ok: true, output: out };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    ctx.dispose();
  }
}
