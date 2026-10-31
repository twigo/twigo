import { describe, expect, test } from "vitest";
import {
  evaluate,
  parseWhen,
  WhenSyntaxError,
  type ContextValue,
} from "./when";

const CONTEXT: Record<string, ContextValue> = {
  listFocus: true,
  inputFocus: false,
  "resource.kind": "Pod",
  "resource.namespace": "kube-system",
  "selection.count": 2,
  "context.name": "prod-eu",
  "space.contexts": ["prod-eu", "staging"],
  empty: "",
};

const holds = (source: string) =>
  evaluate(parseWhen(source), (key) => CONTEXT[key]);

describe("evaluation", () => {
  test.each([
    ["true", true],
    ["false", false],
    ["listFocus", true],
    ["inputFocus", false],
    ["missing", false],
    ["empty", false],
    ["!listFocus", false],
    ["!missing", true],
    ["!true", false],
    ["resource.kind == Pod", true],
    ["resource.kind == 'Pod'", true],
    ["resource.kind != Pod", false],
    ["resource.kind == Deployment", false],
    ["missing != Pod", true],
    ["selection.count == 2", true],
    ["selection.count > 1", true],
    ["selection.count < 2", false],
    ["missing > 0", false],
    ["listFocus == true", true],
    ["listFocus == false", false],
    ["inputFocus != true", true],
    ["listFocus == 'true'", true],
    ["resource.namespace =~ /^kube-/", true],
    ["resource.namespace =~ /^KUBE-/", false],
    ["resource.namespace =~ /^KUBE-/i", true],
    ["context.name =~ /^prod\\/eu$/", false],
    ["context.name in space.contexts", true],
    ["resource.kind in space.contexts", false],
    ["context.name in missing", false],
    ["space.contexts", true],
  ])("%s → %s", (source, expected) => {
    expect(holds(source)).toBe(expected);
  });

  test("&& binds tighter than ||", () => {
    expect(holds("true || false && false")).toBe(true);
    expect(holds("(true || false) && false")).toBe(false);
  });

  test("! applies to one key or a parenthesized group", () => {
    expect(holds("!inputFocus && listFocus")).toBe(true);
    expect(holds("!(inputFocus || listFocus)")).toBe(false);
  });

  test("whitespace is optional around operators", () => {
    expect(holds("listFocus&&resource.kind==Pod&&selection.count>1")).toBe(
      true,
    );
  });
});

describe("syntax errors", () => {
  test.each([
    ["", 0],
    ["listFocus &&", 12],
    ["(listFocus", 10],
    ["listFocus)", 9],
    ["!", 1],
    ["!resource.kind == Pod", 15],
    ["selection.count > many", 18],
    ["resource.kind ==", 16],
    ["resource.namespace =~ kube", 22],
    ["resource.namespace =~ /kube", 22],
    ["resource.namespace =~ /kube/g", 22],
    ["resource.kind == 'Pod", 17],
    ["context.name in", 15],
    ["selection.count >= 1", 17],
  ])("%s fails at %i", (source, offset) => {
    expect(() => parseWhen(source)).toThrow(WhenSyntaxError);
    try {
      parseWhen(source);
    } catch (error) {
      expect((error as WhenSyntaxError).offset).toBe(offset);
    }
  });
});
