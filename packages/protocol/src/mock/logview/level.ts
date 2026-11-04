import type { Level } from "../../generated";
import { lowerAscii } from "../query";

/**
 * A line's level, read from what it says rather than guessed from its
 * colours, as Rust's `logs::level` reads it: a JSON object's level field,
 * logfmt's `level=`, else a level word where loggers print one, before
 * the message. The text is without its escapes.
 */
export function level(text: string): Level | null {
  const trimmed = text.replace(/^[\t\n\f\r ]+/, "");
  if (trimmed.startsWith("{")) {
    const fields = object(trimmed);
    if (fields) return json(fields);
  }
  return logfmt(text) ?? prefix(text);
}

function object(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A JSON object's level: the first of `level` (pino's numbers included),
 * `lvl`, `severity`, `levelname` and `log.level`, which ECS writes as a
 * dotted key and others as `log` holding `level`, that names one. A JSON
 * object says its level in its fields or not at all.
 */
function json(fields: Record<string, unknown>): Level | null {
  const nested = isObject(fields.log) ? fields.log.level : undefined;
  for (const value of [
    fields.level,
    fields.lvl,
    fields.severity,
    fields.levelname,
    fields["log.level"],
    nested,
  ]) {
    const found =
      typeof value === "string"
        ? named(value)
        : typeof value === "number" && Number.isFinite(value)
          ? pino(value)
          : null;
    if (found) return found;
  }
  return null;
}

/** pino's numbers: 10 trace, 20 debug, 30 info, 40 warn, 50 error and 60 fatal, custom levels between them counting as the one below. */
function pino(number: number): Level | null {
  if (number >= 50) return "error";
  if (number >= 40) return "warn";
  if (number >= 30) return "info";
  if (number >= 20) return "debug";
  if (number >= 10) return "trace";
  return null;
}

/** logfmt's `level=` or `lvl=`, at the start or after a space, its value quoted or not. */
function logfmt(text: string): Level | null {
  for (const pair of text.split(" ")) {
    const value = pair.startsWith("level=")
      ? pair.slice("level=".length)
      : pair.startsWith("lvl=")
        ? pair.slice("lvl=".length)
        : null;
    const found = value === null ? null : named(value.replace(/^"+|"+$/g, ""));
    if (found) return found;
  }
  return null;
}

/** How many words from the start a level may come. */
const PREFIX = 4;

const BRACKETS: readonly (readonly [string, string])[] = [
  ["[", "]"],
  ["(", ")"],
  ["<", ">"],
];

/**
 * A level word where loggers print one: klog's `E1103` first, or a word
 * alone, in brackets, or before a colon or logrus's `[0000]` among the
 * first words, after the times, numbers, brackets and dashes that come
 * before it. The first other word starts the message, which says no
 * level, as in `No error found`.
 */
function prefix(text: string): Level | null {
  const words = text
    .split(/[\t\n\f\r ]+/)
    .filter((word) => word !== "")
    .slice(0, PREFIX);
  const first = words[0];
  const header = first === undefined ? null : klog(first);
  if (header) return header;
  for (const word of words) {
    const inner = bracketed(word);
    if (inner !== null) {
      const found = named(inner);
      if (found) return found;
      continue;
    }
    const found = named(word.split(/[:[]/)[0] ?? word);
    if (found) return found;
    const ignorable = /[0-9]/.test(word) || /^[!-/:-@[-`{-~]+$/.test(word);
    if (!ignorable) return null;
  }
  return null;
}

function bracketed(word: string): string | null {
  for (const [open, close] of BRACKETS) {
    const rest = word.startsWith(open) ? word.slice(open.length) : null;
    if (rest?.endsWith(close)) return rest.slice(0, -close.length);
  }
  return null;
}

/** klog's header: its severity's letter and the month and day, as `E1103` (k8s.io/klog v2.130.1, `internal/buffer/buffer.go`, `FormatHeader`). */
function klog(word: string): Level | null {
  const found = /^([IWEF])[0-9]{4}$/.exec(word);
  switch (found?.[1]) {
    case "I":
      return "info";
    case "W":
      return "warn";
    case "E":
    case "F":
      return "error";
    default:
      return null;
  }
}

/** syslog's, Python's, .NET's, zap's, logrus's and slog's names, and the four letters of .NET's console formatter; fatal, critical and panic count as errors. */
const NAMES = new Map<string, Level>([
  ["trace", "trace"],
  ["trce", "trace"],
  ["verbose", "trace"],
  ["debug", "debug"],
  ["dbug", "debug"],
  ["dbg", "debug"],
  ["info", "info"],
  ["information", "info"],
  ["notice", "info"],
  ["warn", "warn"],
  ["warning", "warn"],
  ["error", "error"],
  ["err", "error"],
  ["fail", "error"],
  ["fatal", "error"],
  ["critical", "error"],
  ["crit", "error"],
  ["panic", "error"],
  ["dpanic", "error"],
  ["alert", "error"],
  ["emerg", "error"],
  ["emergency", "error"],
]);

/** The level a word names, in any case of ASCII letters. */
function named(word: string): Level | null {
  return NAMES.get(lowerAscii(word)) ?? null;
}
