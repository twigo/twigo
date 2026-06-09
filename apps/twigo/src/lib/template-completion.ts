import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";

const TOP: Completion[] = [
  { label: "$msg", type: "variable", detail: "request" },
  { label: "$json", type: "variable", detail: "body" },
  { label: "$now", type: "variable", detail: "ISO" },
  { label: "$today", type: "variable", detail: "date" },
  { label: "$timestamp", type: "variable", detail: "epoch ms" },
  { label: "$uuid", type: "function", apply: "$uuid()", detail: "uuid()" },
  { label: "$if", type: "function", detail: "(cond, a, b)" },
  { label: "$ifEmpty", type: "function", detail: "(val, fallback)" },
];

const ARRAY_MEMBERS: Completion[] = [
  { label: "length", type: "property", detail: "number" },
  ...["map", "filter", "find", "join", "slice", "includes"].map(
    (m): Completion => ({ label: m, type: "method" }),
  ),
];

function resolve(data: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = data;
  for (const key of path) {
    if (cur && typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

function brief(v: unknown): string {
  if (Array.isArray(v)) return `array[${v.length}]`;
  if (v === null) return "null";
  return typeof v;
}

function membersOf(value: unknown): Completion[] {
  if (Array.isArray(value)) return ARRAY_MEMBERS;
  if (!value || typeof value !== "object") return [];
  return Object.keys(value).map((k) => ({
    label: k,
    type: "property",
    detail: brief((value as Record<string, unknown>)[k]),
  }));
}

/**
 * IDE-style completion for {{ }} template expressions: `$`-prefixed roots, then
 * dotted paths resolved against the last request's data so real body/header
 * keys are offered (e.g. `$msg.body.` lists the keys seen on the wire).
 */
export function makeTemplateCompletion(
  getData: () => Record<string, unknown>,
): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const token = context.matchBefore(/\$[\w$]*(?:\.[\w$]*)*/);
    if (!token) return null;
    if (token.from === token.to && !context.explicit) return null;

    const text = token.text;
    const dot = text.lastIndexOf(".");
    const partial = dot === -1 ? text : text.slice(dot + 1);
    const from = token.to - partial.length;

    if (dot === -1) {
      return { from, options: TOP, validFor: /^\$[\w$]*$/ };
    }

    const path = text.slice(0, dot).split(".");
    const options = membersOf(resolve(getData(), path));
    if (options.length === 0) return null;
    return { from, options, validFor: /^[\w$]*$/ };
  };
}
