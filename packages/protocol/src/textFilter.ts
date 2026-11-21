import { IpcError } from "./error";

/** ASCII letters in lower case, other characters as they are. */
export function lowerAscii(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

export interface TextFilter {
  keeps(texts: readonly string[]): boolean;
  /** It keeps what lacks its text, so that a text that matches is what it drops. */
  readonly negated: boolean;
}

/**
 * A substring in any case of ASCII letters; `!` before it negates; `/…/`
 * is a regex in any case, `!/…/` its negation. Until the closing slash the
 * text is a substring. Null for text that keeps every row.
 */
export function parseText(source: string): TextFilter | null {
  const text = source.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
  const negated = text.startsWith("!");
  const rest = negated ? text.slice(1) : text;
  let hit: (text: string) => boolean;
  if (rest.length >= 2 && rest.startsWith("/") && rest.endsWith("/")) {
    const pattern = rest.slice(1, -1);
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "i");
    } catch (error) {
      throw new IpcError(
        "filter.invalid-regex",
        `the filter /${pattern}/ is no regex: ${String(error)}`,
      );
    }
    hit = (text) => regex.test(text);
  } else if (rest === "") {
    return null;
  } else {
    const needle = lowerAscii(rest);
    hit = (text) => lowerAscii(text).includes(needle);
  }
  return { keeps: (texts) => texts.some(hit) !== negated, negated };
}
