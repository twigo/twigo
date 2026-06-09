import { describe, it, expect } from "vitest";
import type {
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";
import { makeTemplateCompletion } from "./template-completion";

const data = {
  $msg: {
    subject: "orders.42.get",
    reply: "_INBOX.1",
    headers: { "X-Trace": "abc" },
    size: 10,
    body: { name: "Lana", items: [1, 2, 3] },
    text: "…",
  },
  $json: { name: "Lana", items: [1, 2, 3] },
};

const source = makeTemplateCompletion(() => data);

function ctx(before: string, explicit = false): CompletionContext {
  return {
    explicit,
    matchBefore(re: RegExp) {
      const m = new RegExp(`${re.source}$`).exec(before);
      if (!m) return null;
      return {
        from: before.length - m[0].length,
        to: before.length,
        text: m[0],
      };
    },
  } as unknown as CompletionContext;
}

function run(before: string): CompletionResult | null {
  return source(ctx(before)) as CompletionResult | null;
}

function labels(before: string): string[] {
  const r = run(before);
  return r ? r.options.map((o) => o.label) : [];
}

describe("template completion", () => {
  it("offers the $ roots", () => {
    expect(labels("{{ $")).toEqual(
      expect.arrayContaining(["$msg", "$json", "$uuid", "$now"]),
    );
  });

  it("offers $msg fields after a dot", () => {
    expect(labels("{{ $msg.")).toEqual(
      expect.arrayContaining([
        "subject",
        "reply",
        "headers",
        "size",
        "body",
        "text",
      ]),
    );
  });

  it("offers real body keys from the last request", () => {
    expect(labels("{{ $msg.body.")).toEqual(["name", "items"]);
    expect(labels("{{ $json.")).toEqual(["name", "items"]);
  });

  it("offers header names", () => {
    expect(labels("{{ $msg.headers.")).toEqual(["X-Trace"]);
  });

  it("offers array members for an array value", () => {
    expect(labels("{{ $json.items.")).toEqual(
      expect.arrayContaining(["length", "map", "filter"]),
    );
  });

  it("anchors `from` to the partial being typed", () => {
    const before = "{{ $msg.body.na";
    const r = run(before);
    expect(r).not.toBeNull();
    expect(r?.from).toBe(before.length - "na".length);
  });

  it("does not trigger without a $ token", () => {
    expect(run('{ "foo":')).toBeNull();
  });
});
