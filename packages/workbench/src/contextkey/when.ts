/**
 * When-expressions over context keys (ARCHITECTURE 5.1): the subset `==`,
 * `!=`, `&&`, `||`, `!`, `=~`, `in`, `<`, `>` of VS Code's grammar, with its
 * precedence and coercions (src/vs/platform/contextkey/common/contextkey.ts at
 * 1.144.0): `==` is JavaScript's, `<` and `>` parseFloat the key's value, and
 * `=~` tests it as a string.
 */

export type ContextValue = string | number | boolean | readonly string[];

export type Lookup = (key: string) => ContextValue | undefined;

export type When =
  | { readonly op: "true" | "false" }
  | { readonly op: "has"; readonly key: string }
  | { readonly op: "not"; readonly term: When }
  | { readonly op: "==" | "!="; readonly key: string; readonly value: string }
  | { readonly op: "<" | ">"; readonly key: string; readonly value: number }
  | { readonly op: "=~"; readonly key: string; readonly regex: RegExp }
  | { readonly op: "in"; readonly key: string; readonly list: string }
  | { readonly op: "&&" | "||"; readonly terms: readonly When[] };

export class WhenSyntaxError extends Error {
  constructor(
    readonly source: string,
    readonly offset: number,
    reason: string,
  ) {
    super(`${reason} at ${offset} in "${source}"`);
    this.name = "WhenSyntaxError";
  }
}

type Token =
  | { kind: "word" | "quoted" | "regex"; text: string; at: number }
  | { kind: "op"; text: Operator; at: number }
  | { kind: "end"; at: number };

type Operator = "(" | ")" | "!" | "&&" | "||" | "==" | "!=" | "=~" | "<" | ">";

const OPERATORS: readonly Operator[] = [
  "&&",
  "||",
  "==",
  "!=",
  "=~",
  "(",
  ")",
  "!",
  "<",
  ">",
];

const WORD = /[^\s()!=&|<>'~]+/y;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const char = source.charAt(at);
    if (/\s/.test(char)) {
      at++;
      continue;
    }
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, at));
    if (op) {
      tokens.push({ kind: "op", text: op, at });
      at += op.length;
      if (op === "=~") at = regexAfter(source, at, tokens);
      continue;
    }
    if (char === "'") {
      const close = source.indexOf("'", at + 1);
      if (close < 0) throw new WhenSyntaxError(source, at, "unclosed quote");
      tokens.push({ kind: "quoted", text: source.slice(at + 1, close), at });
      at = close + 1;
      continue;
    }
    WORD.lastIndex = at;
    const word = WORD.exec(source);
    if (!word) throw new WhenSyntaxError(source, at, `unexpected "${char}"`);
    tokens.push({ kind: "word", text: word[0], at });
    at += word[0].length;
  }
  tokens.push({ kind: "end", at });
  return tokens;
}

/** A regex literal `/…/` or `/…/i` follows `=~`; `\/` escapes a slash. */
function regexAfter(source: string, from: number, tokens: Token[]): number {
  let at = from;
  while (/\s/.test(source.charAt(at))) at++;
  if (source.charAt(at) !== "/") {
    throw new WhenSyntaxError(source, at, "expected a regex after =~");
  }
  let end = at + 1;
  while (end < source.length && source.charAt(end) !== "/") {
    end += source.charAt(end) === "\\" ? 2 : 1;
  }
  if (end >= source.length) {
    throw new WhenSyntaxError(source, at, "unclosed regex");
  }
  const flags = /^[a-z]*/.exec(source.slice(end + 1))?.[0] ?? "";
  tokens.push({
    kind: "regex",
    text: source.slice(at, end + 1 + flags.length),
    at,
  });
  return end + 1 + flags.length;
}

export function parseWhen(source: string): When {
  const tokens = tokenize(source);
  let next = 0;
  const peek = () => tokens[next] ?? tokens[tokens.length - 1];
  const fail = (reason: string, at = peek()?.at ?? source.length): never => {
    throw new WhenSyntaxError(source, at, reason);
  };
  const isOp = (text: Operator) => {
    const token = peek();
    return token?.kind === "op" && token.text === text;
  };
  const take = () => tokens[next++];

  const or = (): When => {
    const first = and();
    if (!isOp("||")) return first;
    const terms = [first];
    while (isOp("||")) {
      take();
      terms.push(and());
    }
    return { op: "||", terms };
  };

  const and = (): When => {
    const first = term();
    if (!isOp("&&")) return first;
    const terms = [first];
    while (isOp("&&")) {
      take();
      terms.push(term());
    }
    return { op: "&&", terms };
  };

  const term = (): When => {
    if (!isOp("!")) return primary();
    take();
    const token = peek();
    if (token?.kind === "word" || isOp("(")) {
      return {
        op: "not",
        term: token?.kind === "word" ? constantOrKey() : primary(),
      };
    }
    return fail("expected a key, true, false or ( after !");
  };

  const constantOrKey = (): When => {
    const word = take();
    if (word?.kind !== "word") return fail("expected a key");
    if (word.text === "true" || word.text === "false") return { op: word.text };
    return { op: "has", key: word.text };
  };

  const primary = (): When => {
    if (isOp("(")) {
      take();
      const inner = or();
      if (!isOp(")")) fail("expected )");
      take();
      return inner;
    }
    const left = constantOrKey();
    if (left.op !== "has") return left;
    const { key } = left;
    const token = peek();
    if (token?.kind === "word" && token.text === "in") {
      take();
      const list = take();
      if (list?.kind !== "word") return fail("expected a key after in");
      return { op: "in", key, list: list.text };
    }
    if (token?.kind !== "op") return left;
    switch (token.text) {
      case "==":
      case "!=": {
        take();
        const value = take();
        if (value?.kind !== "word" && value?.kind !== "quoted") {
          return fail(`expected a value after ${token.text}`);
        }
        const boolean =
          value.kind === "word" && /^(true|false)$/.test(value.text);
        if (!boolean) return { op: token.text, key, value: value.text };
        const holds = (value.text === "true") === (token.text === "==");
        return holds ? left : { op: "not", term: left };
      }
      case "<":
      case ">": {
        take();
        const value = take();
        const number = value?.kind === "word" ? Number(value.text) : NaN;
        if (Number.isNaN(number)) {
          return fail(`expected a number after ${token.text}`, value?.at);
        }
        return { op: token.text, key, value: number };
      }
      case "=~": {
        take();
        const literal = take();
        if (literal?.kind !== "regex") return fail("expected a regex");
        const end = literal.text.lastIndexOf("/");
        const flags = literal.text.slice(end + 1);
        if (!/^i?$/.test(flags)) {
          return fail(`unsupported regex flags "${flags}"`, literal.at);
        }
        return {
          op: "=~",
          key,
          regex: new RegExp(literal.text.slice(1, end), flags),
        };
      }
      default:
        return left;
    }
  };

  const expression = or();
  if (peek()?.kind !== "end") fail("unexpected token");
  return expression;
}

export function evaluate(when: When, lookup: Lookup): boolean {
  switch (when.op) {
    case "true":
      return true;
    case "false":
      return false;
    case "has":
      return Boolean(lookup(when.key));
    case "not":
      return !evaluate(when.term, lookup);
    case "==":
      return equals(lookup(when.key), when.value);
    case "!=":
      return !equals(lookup(when.key), when.value);
    case "<":
    case ">": {
      const value = Number.parseFloat(String(lookup(when.key)));
      return when.op === "<" ? value < when.value : value > when.value;
    }
    case "=~":
      return when.regex.test(String(lookup(when.key)));
    case "in": {
      const list = lookup(when.list);
      const value = lookup(when.key);
      return (
        Array.isArray(list) && typeof value === "string" && list.includes(value)
      );
    }
    case "&&":
      return when.terms.every((term) => evaluate(term, lookup));
    case "||":
      return when.terms.some((term) => evaluate(term, lookup));
  }
}

/** JavaScript's `==` against a string, which VS Code compares with: `count == 2.0` holds for the number 2. */
function equals(value: ContextValue | undefined, literal: string): boolean {
  if (value === undefined) return false;
  if (typeof value === "string" || Array.isArray(value)) {
    return String(value) === literal;
  }
  return Number(value) === Number(literal);
}
