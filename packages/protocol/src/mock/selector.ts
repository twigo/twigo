import { IpcError } from "../error";

/** A label selector, parsed as Rust's view parses it, after apimachinery's `labels.Parse`. */
export interface Selector {
  matches(labels: Readonly<Record<string, string>>): boolean;
}

type Op =
  | { readonly kind: "in" | "notin"; readonly values: readonly string[] }
  | { readonly kind: "exists" | "absent" }
  | { readonly kind: "gt" | "lt"; readonly bound: bigint };

interface Requirement {
  readonly key: string;
  readonly op: Op;
}

type Token =
  | { readonly kind: "end" }
  | { readonly kind: "symbol"; readonly text: string }
  | { readonly kind: "in" | "notin" }
  | { readonly kind: "identifier"; readonly text: string };

const SYMBOLS = new Set([")", ",", "!", "==", "=", ">", "<", "!=", "("]);
const SPECIAL = new Set(["=", "!", "(", ")", ",", ">", "<"]);
const WHITESPACE = new Set([" ", "\t", "\r", "\n"]);

function invalid(message: string): IpcError {
  return new IpcError("invalidInput", `the label selector: ${message}`);
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  for (;;) {
    while (at < source.length && WHITESPACE.has(source.charAt(at))) at++;
    if (at === source.length) {
      tokens.push({ kind: "end" });
      return tokens;
    }
    const start = at;
    if (SPECIAL.has(source.charAt(at))) {
      const two = source.slice(at, at + 2);
      const text = SYMBOLS.has(two) ? two : source.charAt(at);
      tokens.push({ kind: "symbol", text });
      at += text.length;
      continue;
    }
    while (
      at < source.length &&
      !SPECIAL.has(source.charAt(at)) &&
      !WHITESPACE.has(source.charAt(at))
    ) {
      at++;
    }
    const text = source.slice(start, at);
    tokens.push(
      text === "in" || text === "notin"
        ? { kind: text }
        : { kind: "identifier", text },
    );
  }
}

/** `in` and `notin` read as identifiers where values go. */
function asValue(token: Token): Token {
  return token.kind === "in" || token.kind === "notin"
    ? { kind: "identifier", text: token.kind }
    : token;
}

function describe(token: Token): string {
  return "text" in token ? token.text : token.kind;
}

const NAME_PART = /^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/;
const SUBDOMAIN_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

function namePart(name: string): boolean {
  return name.length <= 63 && NAME_PART.test(name);
}

function checkKey(key: string): void {
  const slash = key.indexOf("/");
  const valid =
    slash < 0
      ? namePart(key)
      : key.slice(0, slash).length <= 253 &&
        key
          .slice(0, slash)
          .split(".")
          .every((label) => SUBDOMAIN_LABEL.test(label)) &&
        namePart(key.slice(slash + 1));
  if (!valid) throw invalid(`${JSON.stringify(key)} is no label key`);
}

function checkValue(value: string): void {
  if (value !== "" && !namePart(value)) {
    throw invalid(`${JSON.stringify(value)} is no label value`);
  }
}

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

/** A 64-bit integer, as Rust's `i64` and Go's `ParseInt` read one. */
function int64(value: string): bigint | undefined {
  if (!/^[+-]?[0-9]+$/.test(value)) return undefined;
  const number = BigInt(value);
  return number < I64_MIN || number > I64_MAX ? undefined : number;
}

function integer(value: string): bigint {
  const number = int64(value);
  if (number === undefined) {
    throw invalid(
      `${JSON.stringify(value)} is no integer, which > and < compare`,
    );
  }
  return number;
}

class Parser {
  readonly #tokens: Token[];
  #at = 0;

  constructor(tokens: Token[]) {
    this.#tokens = tokens;
  }

  #peek(values: boolean): Token {
    const token = this.#tokens[this.#at] ?? { kind: "end" };
    return values ? asValue(token) : token;
  }

  #next(values: boolean): Token {
    const token = this.#peek(values);
    this.#at++;
    return token;
  }

  #symbol(token: Token, text: string): boolean {
    return token.kind === "symbol" && token.text === text;
  }

  #keyAhead(): boolean {
    const token = this.#peek(true);
    return token.kind === "identifier" || this.#symbol(token, "!");
  }

  #endAhead(): boolean {
    const token = this.#peek(true);
    return token.kind === "end" || this.#symbol(token, ",");
  }

  selector(): Requirement[] {
    const requirements: Requirement[] = [];
    for (;;) {
      if (this.#peek(true).kind === "end") return requirements;
      if (!this.#keyAhead()) {
        throw invalid(`found ${describe(this.#peek(true))}, expected a key`);
      }
      requirements.push(this.#requirement());
      const token = this.#next(true);
      if (token.kind === "end") return requirements;
      if (!this.#symbol(token, ",")) {
        throw invalid(`found ${describe(token)}, expected ','`);
      }
      if (!this.#keyAhead()) throw invalid("expected a key after ','");
    }
  }

  #requirement(): Requirement {
    let token = this.#next(true);
    const absent = this.#symbol(token, "!");
    if (absent) token = this.#next(true);
    if (token.kind !== "identifier") {
      throw invalid(`found ${describe(token)}, expected a key`);
    }
    const key = token.text;
    checkKey(key);
    if (absent) return { key, op: { kind: "absent" } };
    if (this.#endAhead()) return { key, op: { kind: "exists" } };
    const operator = this.#next(false);
    if (operator.kind === "in" || operator.kind === "notin") {
      return { key, op: { kind: operator.kind, values: this.#set() } };
    }
    if (operator.kind === "symbol") {
      switch (operator.text) {
        case "=":
        case "==":
          return { key, op: { kind: "in", values: [this.#exact()] } };
        case "!=":
          return { key, op: { kind: "notin", values: [this.#exact()] } };
        case ">":
          return { key, op: { kind: "gt", bound: integer(this.#exact()) } };
        case "<":
          return { key, op: { kind: "lt", bound: integer(this.#exact()) } };
      }
    }
    throw invalid(
      `found ${describe(operator)}, expected an operator after ${key}`,
    );
  }

  /** `(a,b,c)`; empty values count, as in `(a,,b)`. */
  #set(): string[] {
    if (!this.#symbol(this.#next(true), "(")) throw invalid("expected '('");
    const values = new Set<string>();
    let expectValue = true;
    for (;;) {
      const token = this.#next(true);
      if (token.kind === "identifier" && expectValue) {
        checkValue(token.text);
        values.add(token.text);
        expectValue = false;
      } else if (this.#symbol(token, ",")) {
        if (expectValue) values.add("");
        expectValue = true;
      } else if (this.#symbol(token, ")")) {
        if (expectValue) values.add("");
        return [...values];
      } else {
        throw invalid(`found ${describe(token)}, expected ',' or ')'`);
      }
    }
  }

  /** One value, empty before a comma or the end. */
  #exact(): string {
    if (this.#endAhead()) return "";
    const token = this.#next(true);
    if (token.kind !== "identifier") {
      throw invalid(`found ${describe(token)}, expected a value`);
    }
    checkValue(token.text);
    return token.text;
  }
}

export function parseSelector(source: string): Selector {
  const requirements = new Parser(lex(source)).selector();
  return {
    matches: (labels) =>
      requirements.every(({ key, op }) => {
        const value = Object.prototype.hasOwnProperty.call(labels, key)
          ? labels[key]
          : undefined;
        switch (op.kind) {
          case "in":
            return value !== undefined && op.values.includes(value);
          case "notin":
            return value === undefined || !op.values.includes(value);
          case "exists":
            return value !== undefined;
          case "absent":
            return value === undefined;
          case "gt":
          case "lt": {
            const number = value === undefined ? undefined : int64(value);
            if (number === undefined) return false;
            return op.kind === "gt" ? number > op.bound : number < op.bound;
          }
        }
      }),
  };
}
